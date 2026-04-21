// server.js – Simplified working version for 360ASKME
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

// Simple in‑memory session store
const sessions = new Map();

// Search accommodations function
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

// Main endpoint – simplified to work reliably
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId, language = 'en' } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    // Get or create session
    let state = sessions.get(sessionId);
    if (!state) {
      state = { step: 'start', filters: {} };
      sessions.set(sessionId, state);
    }

    // Check if this is an accommodation request
    const isAccommodation = question.toLowerCase().includes('house') || 
                            question.toLowerCase().includes('apartment') || 
                            question.toLowerCase().includes('rent') ||
                            question.toLowerCase().includes('accommodation');

    if (isAccommodation) {
      // Handle accommodation flow
      if (state.step === 'start') {
        state.step = 'budget';
        sessions.set(sessionId, state);
        return res.json({ 
          answer: "What is your monthly budget in USD? (e.g., $500 or 500)", 
          handoff_data: null 
        });
      }
      
      if (state.step === 'budget') {
        const budgetMatch = question.match(/\d+/);
        if (budgetMatch) {
          state.filters.price_max = parseInt(budgetMatch[0]);
          state.step = 'area';
          sessions.set(sessionId, state);
          return res.json({ 
            answer: "Which area do you prefer? (e.g., Kacyiru, Remera, Nyarutarama)", 
            handoff_data: null 
          });
        } else {
          return res.json({ 
            answer: "Please provide a numeric budget (e.g., $500 or 500)", 
            handoff_data: null 
          });
        }
      }
      
      if (state.step === 'area') {
        state.filters.area = question.trim();
        state.step = 'bedrooms';
        sessions.set(sessionId, state);
        return res.json({ 
          answer: "How many bedrooms do you need? (e.g., 1, 2, 3)", 
          handoff_data: null 
        });
      }
      
      if (state.step === 'bedrooms') {
        const bedroomMatch = question.match(/\d+/);
        if (bedroomMatch) {
          state.filters.bedrooms = parseInt(bedroomMatch[0]);
          // Search the database
          const results = await searchAccommodations(state.filters);
          sessions.delete(sessionId); // End conversation
          
          if (results.length === 0) {
            return res.json({ 
              answer: `I couldn't find any accommodation matching your criteria (budget up to ${state.filters.price_max} USD, area ${state.filters.area}, ${state.filters.bedrooms} bedrooms). Would you like to adjust your filters or speak to a human agent?`,
              handoff_data: { type: 'accommodation', filters: state.filters }
            });
          } else {
            let answerText = `I found ${results.length} option(s) for you:\n\n`;
            results.forEach((r, idx) => {
              answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night or $${r.price_per_month}/month\n   Bedrooms: ${r.bedrooms || 'N/A'}\n   Amenities: ${r.amenities?.join(', ') || 'N/A'}\n\n`;
            });
            answerText += `Would you like me to connect you to a real agent to arrange viewings?`;
            return res.json({ 
              answer: answerText,
              handoff_data: { type: 'accommodation', options: results.map(r => ({ name: r.name, area: r.area, price: r.price_per_night })) }
            });
          }
        } else {
          return res.json({ 
            answer: "Please provide a number of bedrooms (e.g., 1, 2, 3)", 
            handoff_data: null 
          });
        }
      }
    }

    // For general questions (visa, business, etc.) – use OpenAI directly
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are 360ASKME AI, a helpful concierge for Rwanda. Answer questions about visas, business registration, cost of living, safety, events, and tourism. Be friendly, professional, and concise. If you don\'t know, suggest talking to a human concierge.' },
        { role: 'user', content: question }
      ]
    });
    
    const answer = completion.choices[0].message.content;
    return res.json({ answer, handoff_data: { type: 'general', question: question } });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 360ASKME AI running on port ${PORT}`));
