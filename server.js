// server.js – Focused on Accommodation (Hotels, Apartments, Guesthouses)
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
  if (filters.type) {
    params.push(filters.type);
    sql += ` AND type = $${params.length}`;
  }
  sql += ` LIMIT 5`;
  
  const result = await pool.query(sql, params);
  return result.rows;
}

// Main endpoint
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    // Get or create session
    let state = sessions.get(sessionId);
    if (!state) {
      state = { step: 'start', filters: {} };
      sessions.set(sessionId, state);
    }

    const q = question.toLowerCase();
    
    // Check if this is an accommodation request
    const isAccommodation = q.includes('house') || q.includes('apartment') || q.includes('hotel') || 
                            q.includes('guesthouse') || q.includes('place to stay') || q.includes('accommodation') ||
                            q.includes('room') || q.includes('lodge') || q.includes('villa');
    
    // Handle accommodation flow
    if (isAccommodation || state.step !== 'start') {
      
      // Step 1: Start - extract type and area
      if (state.step === 'start') {
        // Detect accommodation type
        if (q.includes('hotel')) state.filters.type = 'hotel';
        else if (q.includes('guesthouse')) state.filters.type = 'guesthouse';
        else if (q.includes('apartment')) state.filters.type = 'apartment';
        else if (q.includes('house')) state.filters.type = 'house';
        
        // Try to extract area
        const areas = ['kacyiru', 'kiyovu', 'remera', 'nyarutarama', 'kimihurura', 'muhanga', 'rubavu', 'huye', 'musanze'];
        for (const area of areas) {
          if (q.includes(area)) {
            state.filters.area = area.charAt(0).toUpperCase() + area.slice(1);
            break;
          }
        }
        
        state.step = 'budget';
        sessions.set(sessionId, state);
        
        let typeMsg = state.filters.type ? state.filters.type + ' ' : '';
        let areaMsg = state.filters.area ? ` in ${state.filters.area}` : '';
        return res.json({ answer: `What is your budget in USD for this ${typeMsg}accommodation${areaMsg}?`, handoff_data: null });
      }
      
      // Step 2: Get budget
      if (state.step === 'budget') {
        const match = question.match(/\d+/);
        if (match) {
          state.filters.price_max = parseInt(match[0]);
          state.step = 'area';
          sessions.set(sessionId, state);
          return res.json({ answer: `Which area do you prefer? (e.g., Kacyiru, Kiyovu, Remera, Muhanga, Rubavu)`, handoff_data: null });
        }
        return res.json({ answer: `Please provide a numeric budget (e.g., 50 for $50 per night)`, handoff_data: null });
      }
      
      // Step 3: Get area
      if (state.step === 'area') {
        const areas = ['kacyiru', 'kiyovu', 'remera', 'nyarutarama', 'kimihurura', 'muhanga', 'rubavu', 'huye', 'musanze', 'kigali'];
        let foundArea = null;
        for (const area of areas) {
          if (question.toLowerCase().includes(area)) {
            foundArea = area.charAt(0).toUpperCase() + area.slice(1);
            break;
          }
        }
        if (foundArea) {
          state.filters.area = foundArea;
        } else if (question.trim().length > 0) {
          state.filters.area = question.trim();
        }
        
        state.step = 'search';
        sessions.set(sessionId, state);
        
        // Search immediately
        const results = await searchAccommodations(state.filters);
        sessions.delete(sessionId);
        
        if (results.length === 0) {
          return res.json({ answer: `I couldn't find any accommodation matching your criteria (budget up to $${state.filters.price_max}, area: ${state.filters.area || 'any'}). Would you like to adjust your search or speak to a human concierge?`, handoff_data: { type: 'accommodation', filters: state.filters } });
        }
        
        let answerText = `I found ${results.length} option(s) for you:\n\n`;
        results.forEach((r, idx) => {
          answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night\n   Rating: ${r.rating || 'N/A'}\n`;
          if (r.amenities) answerText += `   Amenities: ${r.amenities.join(', ')}\n`;
          answerText += `\n`;
        });
        answerText += `Would you like me to connect you to a human concierge to book this for you?`;
        return res.json({ answer: answerText, handoff_data: { type: 'accommodation', options: results } });
      }
    }
    
    // For general questions (not accommodation)
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are 360ASKME AI, the presidential concierge for Rwanda. Answer questions about visas, business, cost of living, tourism, and culture. Be warm and professional. Always offer to connect to a human concierge.` },
        { role: 'user', content: question }
      ]
    });
    
    return res.json({ answer: completion.choices[0].message.content, handoff_data: null });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 360ASKME AI running on port ${PORT}`));
