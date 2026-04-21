// server.js – Complete Presidential AI for 360ASKME
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();

// ========== CORS CONFIGURATION (FIXED) ==========
// Allow requests from your Netlify domain and local development
app.use(cors({
  origin: [
    'https://360askme.com',
    'https://www.360askme.com',
    'https://360askme.netlify.app',
    'http://localhost:3000',
    'http://localhost:5500'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// PostgreSQL connection (uses DATABASE_URL from environment)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// OpenAI setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Session store (in‑memory)
const sessions = new Map();

// Helper: generate embedding for RAG
async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// Helper: search government knowledge (RAG)
async function searchGovKnowledge(query, limit = 5) {
  const queryEmbedding = await getEmbedding(query);
  const result = await pool.query(
    `SELECT content, source_url, title 
     FROM gov_knowledge 
     ORDER BY embedding <-> $1 
     LIMIT $2`,
    [JSON.stringify(queryEmbedding), limit]
  );
  return result.rows;
}

// Helper: search accommodations (structured)
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
      { role: 'system', content: `Classify the user's question into one of:
        - "general": anything about Rwanda that is not a service request (visa, taxes, safety, history, events, culture, cost of living, etc.)
        - "accommodation": looking for a house, apartment, hotel, guesthouse, Airbnb, or place to stay.
        Respond with JSON: { "intent": "general" or "accommodation" }` },
      { role: 'user', content: question }
    ],
    response_format: { type: 'json_object' }
  });
  const result = JSON.parse(completion.choices[0].message.content);
  return result.intent;
}

// Main endpoint
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId, language = 'en' } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    // First, classify the intent
    const intent = await classifyIntent(question);

    // Handle general questions (RAG)
    if (intent === 'general') {
      const docs = await searchGovKnowledge(question);
      const context = docs.map(d => d.content).join('\n\n');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `You are 360ASKME AI. Answer the user's question based ONLY on the following context from official government sources. If the context does not contain the answer, say "I don't have that information yet. Please ask our human concierge for help." Be warm, professional, and presidential‑level. End with a call to action to connect to a human if needed.` },
          { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` }
        ]
      });
      const answer = completion.choices[0].message.content;
      const handoffData = { type: 'general', question: question };
      return res.json({ answer, handoff_data: handoffData });
    }

    // Handle accommodation (conversational)
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        intent: 'accommodation',
        filters: {},
        waitingFor: 'budget',
        lastQuestion: null
      };
      sessions.set(sessionId, state);
    }

    const systemPrompt = `You are 360ASKME AI, helping users find accommodation in Rwanda.
Current session: waitingFor = ${state.waitingFor}, filters = ${JSON.stringify(state.filters)}.
User just said: "${question}"

Rules:
- If waitingFor = "budget", extract a numeric budget (in USD or RWF, convert to USD). Store as price_max in filters. Then set waitingFor = "area".
- If waitingFor = "area", extract the area name (e.g., Kacyiru, Remera). Store as area. Then set waitingFor = "bedrooms".
- If waitingFor = "bedrooms", extract number of bedrooms (1,2,3). Store as bedrooms. Then set waitingFor = "done".
- When waitingFor = "done", do not ask more questions; respond with action = "search".
- Always respond in JSON: { "action": "ask" or "search", "message": "text for user", "updated_filters": {}, "waitingFor_next": "..." }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      response_format: { type: 'json_object' }
    });
    const aiResponse = JSON.parse(completion.choices[0].message.content);

    if (aiResponse.updated_filters) Object.assign(state.filters, aiResponse.updated_filters);
    if (aiResponse.waitingFor_next) state.waitingFor = aiResponse.waitingFor_next;

    if (aiResponse.action === 'search') {
      const results = await searchAccommodations(state.filters);
      let answerText = '';
      let handoffData = null;
      if (results.length === 0) {
        answerText = `I couldn't find any accommodation matching your criteria (budget up to ${state.filters.price_max || '?'} USD, area ${state.filters.area || 'any'}, ${state.filters.bedrooms || 'any'} bedrooms). Would you like to adjust your filters or speak to a human agent?`;
        handoffData = { type: 'accommodation', no_results: true, filters: state.filters };
      } else {
        answerText = `I found ${results.length} option(s):\n\n`;
        results.forEach((r, idx) => {
          answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night or $${r.price_per_month}/month\n   Bedrooms: ${r.bedrooms || 'N/A'}\n   Amenities: ${r.amenities?.join(', ') || 'N/A'}\n\n`;
        });
        answerText += `Would you like me to connect you to a real agent who can arrange viewings?`;
        handoffData = { type: 'accommodation', options: results.map(r => ({ id: r.id, name: r.name, price: r.price_per_night, area: r.area })) };
      }
      sessions.delete(sessionId);
      return res.json({ answer: answerText, handoff_data: handoffData });
    }

    sessions.set(sessionId, state);
    return res.json({ answer: aiResponse.message, handoff_data: null });

  } catch (error) {
    console.error('Error in /ask:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 360ASKME Presidential AI running on port ${PORT}`));
