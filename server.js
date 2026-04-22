// server.js – Full Presidential AI for All 8 Services
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

const sessions = new Map();

// Search function that picks the right table
async function searchService(serviceType, filters) {
  let sql = '';
  const params = [];

  switch (serviceType) {
    case 'accommodation':
      sql = `SELECT * FROM accommodations WHERE 1=1`;
      if (filters.area) { params.push(`%${filters.area}%`); sql += ` AND area ILIKE $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price_per_night <= $${params.length}`; }
      if (filters.bedrooms) { params.push(filters.bedrooms); sql += ` AND bedrooms = $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'office':
      sql = `SELECT * FROM offices WHERE 1=1`;
      if (filters.area) { params.push(`%${filters.area}%`); sql += ` AND area ILIKE $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price_per_month <= $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'land':
      sql = `SELECT * FROM land WHERE 1=1`;
      if (filters.zone_type) { params.push(filters.zone_type); sql += ` AND zone_type = $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price_total <= $${params.length}`; }
      if (filters.city) { params.push(`%${filters.city}%`); sql += ` AND city ILIKE $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'vehicle':
      sql = `SELECT * FROM vehicles WHERE 1=1`;
      if (filters.type) { params.push(filters.type); sql += ` AND type = $${params.length}`; }
      if (filters.fuel_type) { params.push(filters.fuel_type); sql += ` AND fuel_type = $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price <= $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'industrial':
      sql = `SELECT * FROM industrial_spaces WHERE 1=1`;
      if (filters.type) { params.push(filters.type); sql += ` AND type = $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price_per_month <= $${params.length}`; }
      if (filters.city) { params.push(`%${filters.city}%`); sql += ` AND city ILIKE $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'tourism':
      sql = `SELECT * FROM tourism_services WHERE 1=1`;
      if (filters.service_type) { params.push(filters.service_type); sql += ` AND service_type = $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price_adult <= $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'business':
      sql = `SELECT * FROM business_services WHERE 1=1`;
      if (filters.service_type) { params.push(`%${filters.service_type}%`); sql += ` AND service_type ILIKE $${params.length}`; }
      if (filters.price_max) { params.push(filters.price_max); sql += ` AND price_from <= $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    case 'professional':
      sql = `SELECT * FROM professional_services WHERE 1=1`;
      if (filters.service_type) { params.push(`%${filters.service_type}%`); sql += ` AND service_type ILIKE $${params.length}`; }
      if (filters.budget_max) { params.push(filters.budget_max); sql += ` AND budget_min <= $${params.length}`; }
      sql += ` LIMIT 5`;
      break;
    default:
      return [];
  }
  
  const result = await pool.query(sql, params);
  return result.rows;
}

// Detect service type from user question
function detectServiceType(question) {
  const q = question.toLowerCase();
  if (q.includes('house') || q.includes('apartment') || q.includes('flat') || q.includes('studio') || q.includes('accommodation')) return 'accommodation';
  if (q.includes('office') || q.includes('commercial space')) return 'office';
  if (q.includes('land') || q.includes('plot')) return 'land';
  if (q.includes('car') || q.includes('vehicle') || q.includes('motorbike') || q.includes('truck')) return 'vehicle';
  if (q.includes('warehouse') || q.includes('hangar') || q.includes('factory') || q.includes('industrial')) return 'industrial';
  if (q.includes('tour') || q.includes('gorilla') || q.includes('trekking') || q.includes('airport') || q.includes('guide')) return 'tourism';
  if (q.includes('company') || q.includes('registration') || q.includes('tax') || q.includes('visa') || q.includes('work permit')) return 'business';
  if (q.includes('architect') || q.includes('lawyer') || q.includes('consultant') || q.includes('designer') || q.includes('accountant')) return 'professional';
  return null;
}

// Main endpoint
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const serviceType = detectServiceType(question);
    
    // If it's a service request (not general conversation)
    if (serviceType) {
      let state = sessions.get(sessionId);
      if (!state || state.serviceType !== serviceType) {
        state = { serviceType, step: 'start', filters: {} };
        sessions.set(sessionId, state);
      }

      if (state.step === 'start') {
        state.step = 'budget';
        sessions.set(sessionId, state);
        return res.json({ answer: `What is your budget in USD for this ${serviceType}?`, handoff_data: null });
      }
      
      if (state.step === 'budget') {
        const match = question.match(/\d+/);
        if (match) {
          state.filters.price_max = parseInt(match[0]);
          state.step = 'area';
          sessions.set(sessionId, state);
          return res.json({ answer: `Which area do you prefer? (e.g., Kacyiru, Kiyovu, Remera)`, handoff_data: null });
        }
        return res.json({ answer: `Please provide a numeric budget (e.g., 500)`, handoff_data: null });
      }
      
      if (state.step === 'area') {
        state.filters.area = question.trim();
        state.step = 'details';
        sessions.set(sessionId, state);
        
        // Ask for service-specific details
        if (serviceType === 'accommodation') {
          return res.json({ answer: `How many bedrooms do you need?`, handoff_data: null });
        } else if (serviceType === 'vehicle') {
          return res.json({ answer: `What type of fuel? (petrol, diesel, electric, hybrid)`, handoff_data: null });
        } else if (serviceType === 'land') {
          return res.json({ answer: `What type of land? (residential, commercial, agricultural, industrial)`, handoff_data: null });
        } else {
          return res.json({ answer: `Great. Let me search for options.`, handoff_data: null });
        }
      }
      
      if (state.step === 'details') {
        // Capture extra details
        if (serviceType === 'accommodation') {
          const match = question.match(/\d+/);
          if (match) state.filters.bedrooms = parseInt(match[0]);
        } else if (serviceType === 'vehicle') {
          const fuel = question.toLowerCase();
          if (fuel.includes('petrol')) state.filters.fuel_type = 'petrol';
          else if (fuel.includes('diesel')) state.filters.fuel_type = 'diesel';
          else if (fuel.includes('electric')) state.filters.fuel_type = 'electric';
          else if (fuel.includes('hybrid')) state.filters.fuel_type = 'hybrid';
        } else if (serviceType === 'land') {
          const type = question.toLowerCase();
          if (type.includes('residential')) state.filters.zone_type = 'residential';
          else if (type.includes('commercial')) state.filters.zone_type = 'commercial';
          else if (type.includes('agricultural')) state.filters.zone_type = 'agricultural';
          else if (type.includes('industrial')) state.filters.zone_type = 'industrial';
        }
        
        const results = await searchService(serviceType, state.filters);
        sessions.delete(sessionId);
        
        if (results.length === 0) {
          return res.json({ answer: `I couldn't find any ${serviceType} matching your criteria. Would you like to adjust your search or speak to a human concierge?`, handoff_data: { serviceType, filters: state.filters } });
        }
        
        let answerText = `I found ${results.length} option(s) for ${serviceType}:\n\n`;
        results.forEach((r, idx) => {
          if (serviceType === 'accommodation') answerText += `${idx+1}. **${r.name}** - ${r.area} - $${r.price_per_night}/night - ${r.bedrooms} bed(s)\n`;
          else if (serviceType === 'office') answerText += `${idx+1}. **${r.name}** - ${r.area} - $${r.price_per_month}/month - ${r.size_sqm} sqm\n`;
          else if (serviceType === 'land') answerText += `${idx+1}. **${r.title}** - ${r.city} - $${r.price_total} - ${r.area_sqm} sqm\n`;
          else if (serviceType === 'vehicle') answerText += `${idx+1}. **${r.title}** - ${r.brand} ${r.model} - $${r.price}\n`;
          else if (serviceType === 'industrial') answerText += `${idx+1}. **${r.name}** - ${r.city} - $${r.price_per_month}/month - ${r.area_sqm} sqm\n`;
          else if (serviceType === 'tourism') answerText += `${idx+1}. **${r.provider_name}** - ${r.service_type} - $${r.price_adult}\n`;
          else if (serviceType === 'business') answerText += `${idx+1}. **${r.provider_name}** - ${r.service_type} - from $${r.price_from}\n`;
          else if (serviceType === 'professional') answerText += `${idx+1}. **${r.provider_name}** - ${r.service_type} - budget $${r.budget_min}-$${r.budget_max}\n`;
        });
        answerText += `\nWould you like me to connect you to a human concierge to proceed?`;
        return res.json({ answer: answerText, handoff_data: { serviceType, options: results } });
      }
    }
    
    // General conversation (use OpenAI)
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
