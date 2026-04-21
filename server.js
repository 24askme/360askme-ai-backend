// server.js – Full Presidential AI for 360ASKME
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Session store
const sessions = new Map();

// Helper: search accommodations
async function searchAccommodations(filters) {
  let sql = `SELECT * FROM accommodations WHERE 1=1`;
  const params = [];
  if (filters.area) {
    params.push(`%${filters.area}%`);
    sql += ` AND area ILIKE $${params.length}`;
  }
  if (filters.price_max) {
    params.push(filters.price_max);
    sql += ` AND price_per_night <= $${params.length}`;
  }
  if (filters.bedrooms) {
    params.push(filters.bedrooms);
    sql += ` AND bedrooms = $${params.length}`;
  }
  sql += ` LIMIT 5`;
  const result = await pool.query(sql, params);
  return result.rows;
}

// Intent classification using OpenAI
async function classifyIntent(question) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Classify the user's question into:
        - "general": anything about Rwanda (visa, taxes, safety, cost of living, events, culture, business registration, etc.)
        - "accommodation": looking for a house, apartment, hotel, guesthouse, place to stay.
        Respond with JSON: { "intent": "general" or "accommodation" }` },
      { role: 'user', content: question }
    ],
    response_format: { type: 'json_object' }
  });
  const result = JSON.parse(completion.choices[0].message.content);
  return result.intent;
}

// Extract accommodation filters from natural language
async function extractFilters(question, currentFilters) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Extract accommodation filters from the user's message. 
        Current filters: ${JSON.stringify(currentFilters)}.
        Return JSON with: { "price_max": number or null, "area": string or null, "bedrooms": number or null, "all_found": boolean }` },
      { role: 'user', content: question }
    ],
    response_format: { type: 'json_object' }
  });
  const result = JSON.parse(completion.choices[0].message.content);
  return result;
}

// Main endpoint
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId, language = 'en' } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    // Get or create session
    let state = sessions.get(sessionId);
    if (!state) {
      state = { intent: null, filters: {}, step: null };
      sessions.set(sessionId, state);
    }

    // If we are in the middle of accommodation search, try to extract filters from the message
    if (state.intent === 'accommodation') {
      const extracted = await extractFilters(question, state.filters);
      let updated = false;
      
      if (extracted.price_max) { state.filters.price_max = extracted.price_max; updated = true; }
      if (extracted.area) { state.filters.area = extracted.area; updated = true; }
      if (extracted.bedrooms) { state.filters.bedrooms = extracted.bedrooms; updated = true; }
      
      if (extracted.all_found || (state.filters.price_max && state.filters.area && state.filters.bedrooms)) {
        // All filters collected – search database
        const results = await searchAccommodations(state.filters);
        sessions.delete(sessionId);
        
        if (results.length === 0) {
          return res.json({ 
            answer: `I couldn't find any accommodation matching your criteria (budget up to ${state.filters.price_max} USD, area ${state.filters.area}, ${state.filters.bedrooms} bedrooms). Would you like to adjust your filters or speak to a human agent?`,
            handoff_data: { type: 'accommodation', filters: state.filters }
          });
        } else {
          let answerText = `I found ${results.length} option(s) matching your needs:\n\n`;
          results.forEach((r, idx) => {
            answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night or $${r.price_per_month}/month\n   Bedrooms: ${r.bedrooms || 'N/A'}\n   Amenities: ${r.amenities?.join(', ') || 'N/A'}\n\n`;
          });
          answerText += `Would you like me to connect you to a real agent who can arrange viewings?`;
          return res.json({ 
            answer: answerText,
            handoff_data: { type: 'accommodation', options: results.map(r => ({ name: r.name, area: r.area, price: r.price_per_night })) }
          });
        }
      } else {
        // Ask for missing information
        let missing = [];
        if (!state.filters.price_max) missing.push("your budget in USD");
        if (!state.filters.area) missing.push("the area (e.g., Kacyiru, Remera)");
        if (!state.filters.bedrooms) missing.push("the number of bedrooms");
        return res.json({ 
          answer: `I need ${missing.join(', ')}. Could you please provide that information?`,
          handoff_data: null 
        });
      }
    }

    // Classify intent for new conversations
    const intent = await classifyIntent(question);
    
    if (intent === 'accommodation') {
      state.intent = 'accommodation';
      state.filters = {};
      sessions.set(sessionId, state);
      
      // Try to extract filters from the first message
      const extracted = await extractFilters(question, {});
      if (extracted.price_max) state.filters.price_max = extracted.price_max;
      if (extracted.area) state.filters.area = extracted.area;
      if (extracted.bedrooms) state.filters.bedrooms = extracted.bedrooms;
      
      if (state.filters.price_max && state.filters.area && state.filters.bedrooms) {
        // All filters provided in one message – search immediately
        const results = await searchAccommodations(state.filters);
        sessions.delete(sessionId);
        
        if (results.length === 0) {
          return res.json({ 
            answer: `I couldn't find any accommodation matching your criteria. Would you like to adjust or speak to a human agent?`,
            handoff_data: { type: 'accommodation', filters: state.filters }
          });
        } else {
          let answerText = `I found ${results.length} option(s) for you:\n\n`;
          results.forEach((r, idx) => {
            answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night or $${r.price_per_month}/month\n   Bedrooms: ${r.bedrooms || 'N/A'}\n   Amenities: ${r.amenities?.join(', ') || 'N/A'}\n\n`;
          });
          answerText += `Would you like me to connect you to a real agent?`;
          return res.json({ 
            answer: answerText,
            handoff_data: { type: 'accommodation', options: results.map(r => ({ name: r.name, area: r.area, price: r.price_per_night })) }
          });
        }
      } else {
        // Ask for missing information
        let missing = [];
        if (!state.filters.price_max) missing.push("your budget in USD");
        if (!state.filters.area) missing.push("the area");
        if (!state.filters.bedrooms) missing.push("the number of bedrooms");
        return res.json({ 
          answer: `I'd be happy to help you find accommodation. Could you please tell me ${missing.join(', ')}?`,
          handoff_data: null 
        });
      }
    }
    
    // General questions – use RAG or direct OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are 360ASKME AI, the official presidential‑level concierge for Rwanda. 
          You are warm, professional, and extremely knowledgeable about Rwanda.
          Answer questions about: visas, business registration, taxes, cost of living, safety, tourism, gorilla trekking, events, culture, and anything else related to Rwanda.
          Be conversational, helpful, and concise. 
          If the user asks about accommodation, guide them to provide budget, area, and bedrooms.
          Always end with an offer to connect to a human concierge for personalized service.
          Tagline: "Stop searching. Just ask me."` },
        { role: 'user', content: question }
      ]
    });
    
    const answer = completion.choices[0].message.content;
    return res.json({ answer, handoff_data: { type: 'general', question: question } });

  } catch (error) {
    console.error('Error in /ask:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 360ASKME Presidential AI running on port ${PORT}`));
