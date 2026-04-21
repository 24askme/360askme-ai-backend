// server.js – Working Presidential AI for 360ASKME
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

// Search accommodations
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

// Main endpoint – simplified for reliability
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId, language = 'en' } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    console.log(`[${sessionId}] Question: ${question}`);

    // Get or create session
    let state = sessions.get(sessionId);
    if (!state) {
      state = { step: 'start', filters: {} };
      sessions.set(sessionId, state);
      console.log(`[${sessionId}] New session created`);
    }

    console.log(`[${sessionId}] Current step: ${state.step}, filters:`, state.filters);

    // Check if this is an accommodation request
    const accommodationKeywords = ['house', 'apartment', 'flat', 'studio', 'villa', 'rent', 'accommodation', 'place to stay', 'property', 'home'];
    const isAccommodation = accommodationKeywords.some(keyword => question.toLowerCase().includes(keyword));

    // Handle accommodation flow
    if (isAccommodation || state.step !== 'start') {
      
      // Step 1: Start or extract budget
      if (state.step === 'start') {
        // Try to extract budget from the question
        const budgetMatch = question.match(/\$?(\d+)/);
        if (budgetMatch) {
          state.filters.price_max = parseInt(budgetMatch[1]);
          state.step = 'area';
          sessions.set(sessionId, state);
          console.log(`[${sessionId}] Extracted budget: ${state.filters.price_max}, moving to area`);
          return res.json({ 
            answer: `Great. Which area do you prefer? (e.g., Kacyiru, Remera, Nyarutarama, Kiyovu)`, 
            handoff_data: null 
          });
        } else {
          state.step = 'budget';
          sessions.set(sessionId, state);
          console.log(`[${sessionId}] Asking for budget`);
          return res.json({ 
            answer: `I'd be happy to help you find accommodation. What is your monthly budget in USD? (e.g., $500 or 500)`, 
            handoff_data: null 
          });
        }
      }
      
      // Step 2: Get budget
      if (state.step === 'budget') {
        const budgetMatch = question.match(/\$?(\d+)/);
        if (budgetMatch) {
          state.filters.price_max = parseInt(budgetMatch[1]);
          state.step = 'area';
          sessions.set(sessionId, state);
          console.log(`[${sessionId}] Budget set to ${state.filters.price_max}, moving to area`);
          return res.json({ 
            answer: `Got it. Which area do you prefer? (e.g., Kacyiru, Remera, Nyarutarama, Kiyovu)`, 
            handoff_data: null 
          });
        } else {
          console.log(`[${sessionId}] No budget found in: ${question}`);
          return res.json({ 
            answer: `Please provide a numeric budget (e.g., $500 or 500)`, 
            handoff_data: null 
          });
        }
      }
      
      // Step 3: Get area
      if (state.step === 'area') {
        state.filters.area = question.trim();
        state.step = 'bedrooms';
        sessions.set(sessionId, state);
        console.log(`[${sessionId}] Area set to ${state.filters.area}, moving to bedrooms`);
        return res.json({ 
          answer: `How many bedrooms do you need? (e.g., 1, 2, 3)`, 
          handoff_data: null 
        });
      }
      
      // Step 4: Get bedrooms and search
      if (state.step === 'bedrooms') {
        const bedroomMatch = question.match(/\d+/);
        if (bedroomMatch) {
          state.filters.bedrooms = parseInt(bedroomMatch[0]);
          console.log(`[${sessionId}] Bedrooms set to ${state.filters.bedrooms}, searching database...`);
          
          const results = await searchAccommodations(state.filters);
          sessions.delete(sessionId);
          
          if (results.length === 0) {
            console.log(`[${sessionId}] No results found`);
            return res.json({ 
              answer: `I couldn't find any accommodation matching your criteria (budget up to ${state.filters.price_max} USD, area ${state.filters.area}, ${state.filters.bedrooms} bedrooms). Would you like to adjust your search or speak to a human concierge?`,
              handoff_data: { type: 'accommodation', filters: state.filters }
            });
          } else {
            console.log(`[${sessionId}] Found ${results.length} results`);
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
          console.log(`[${sessionId}] No bedrooms found in: ${question}`);
          return res.json({ 
            answer: `Please provide a number of bedrooms (e.g., 1, 2, 3)`, 
            handoff_data: null 
          });
        }
      }
    }
    
    // For general questions (visa, business, etc.)
    console.log(`[${sessionId}] Processing general question`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are 360ASKME AI, the official presidential‑level concierge for Rwanda. 
          You are warm, professional, and extremely knowledgeable about Rwanda.
          Answer questions about: visas, business registration, taxes, cost of living, safety, tourism, gorilla trekking, events, culture.
          Be conversational, helpful, and concise.
          Always end with an offer to connect to a human concierge for personalized service.
          Tagline: "Stop searching. Just ask me."` },
        { role: 'user', content: question }
      ]
    });
    
    const answer = completion.choices[0].message.content;
    console.log(`[${sessionId}] General answer sent`);
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
app.listen(PORT, () => console.log(`✅ 360ASKME AI running on port ${PORT}`));
