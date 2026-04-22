// Debug version – accommodation only
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sessions = new Map();

async function searchAccommodations(filters) {
  console.log('Searching with filters:', filters);
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
  console.log('SQL:', sql, 'Params:', params);
  const result = await pool.query(sql, params);
  console.log('Results:', result.rows.length);
  return result.rows;
}

app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId } = req.body;
    console.log(`[${sessionId}] Question: "${question}"`);
    
    let state = sessions.get(sessionId);
    if (!state) {
      state = { step: 'start', filters: {} };
      sessions.set(sessionId, state);
      console.log(`[${sessionId}] New session, step: start`);
    }
    
    console.log(`[${sessionId}] Current step: ${state.step}, filters:`, state.filters);
    
    // Handle accommodation flow
    if (state.step === 'start') {
      state.step = 'budget';
      sessions.set(sessionId, state);
      return res.json({ answer: "What is your monthly budget in USD? (e.g., 500)", handoff_data: null });
    }
    
    if (state.step === 'budget') {
      const match = question.match(/\d+/);
      if (match) {
        state.filters.price_max = parseInt(match[0]);
        state.step = 'area';
        sessions.set(sessionId, state);
        return res.json({ answer: "Which area do you prefer? (e.g., Kacyiru, Remera)", handoff_data: null });
      }
      return res.json({ answer: "Please provide a number for your budget (e.g., 500)", handoff_data: null });
    }
    
    if (state.step === 'area') {
      state.filters.area = question.trim();
      state.step = 'bedrooms';
      sessions.set(sessionId, state);
      return res.json({ answer: "How many bedrooms do you need? (e.g., 2)", handoff_data: null });
    }
    
    if (state.step === 'bedrooms') {
      const match = question.match(/\d+/);
      if (match) {
        state.filters.bedrooms = parseInt(match[0]);
        console.log(`[${sessionId}] Searching with filters:`, state.filters);
        const results = await searchAccommodations(state.filters);
        sessions.delete(sessionId);
        
        if (results.length === 0) {
          return res.json({ answer: "No properties found. Please try different criteria or contact a human concierge.", handoff_data: { type: 'accommodation' } });
        }
        
        let answerText = `I found ${results.length} option(s):\n\n`;
        results.forEach((r, i) => {
          answerText += `${i+1}. ${r.name} - ${r.area} - $${r.price_per_night}/night - ${r.bedrooms} bed(s)\n`;
        });
        answerText += `\nWould you like to connect to a human agent?`;
        return res.json({ answer: answerText, handoff_data: { type: 'accommodation', options: results } });
      }
      return res.json({ answer: "Please provide a number of bedrooms (e.g., 2)", handoff_data: null });
    }
    
  } catch (error) {
    console.error('ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Debug server running on port ${PORT}`));
