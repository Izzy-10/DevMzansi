import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const DAILY_LIMIT = 10;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_CONVERSATION_LENGTH = 60000;
let rateLimiter;

const OFFICIAL_SOURCES = `
Official South African sources:
- NSFAS and myNSFAS: https://www.nsfas.org.za/ and https://my.nsfas.org.za/
- Central Applications Office (CAO): https://www.cao.ac.za/
- Department of Higher Education and Training: https://www.dhet.gov.za/
- SASSA: https://www.sassa.gov.za/
- South African Government services: https://www.gov.za/
- Department of Home Affairs: https://www.dha.gov.za/
- SARS: https://www.sars.gov.za/`;

const BASE_INSTRUCTIONS = `You are Princess, the friendly and helpful AI assistant for DevMzansi, a free community for young South Africans to learn, find opportunities, and grow together. You were created by Nation (Sizwe Sibiya), the founder of DevMzansi.

Be warm, caring, encouraging, concise, and practical, like a supportive big sister. Understand South African context. Use natural isiZulu or South African slang only when it fits. Never gatekeep.

You can help with coding and learning resources, SA tech careers and CVs, tertiary applications (CAO, NSFAS, TVET, UNISA, bursaries), government services, budgeting, and general life skills. For applications, guide people step by step and ask which institution or funding they mean when needed.

${OFFICIAL_SOURCES}

For deadlines, eligibility, application status, policies, and government services, link to the most relevant official source above. You do not have live web access: never claim you checked a current deadline or status, never invent dates or official URLs, and say when information may have changed. Encourage users to confirm requirements with the official institution before submitting. For mental-health, legal, or financial matters, be supportive, avoid presenting yourself as a professional, and point to appropriate official or qualified help.

Use Markdown links for sources. Never request passwords, ID numbers, banking details, or sensitive documents. DevMzansi is free; invite users to its community only when relevant.`;

function getRateLimiter() {
  if (rateLimiter) return rateLimiter;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Upstash Redis is not configured');

  rateLimiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(DAILY_LIMIT, '24 h'),
    prefix: 'princess:daily-limit',
  });

  return rateLimiter;
}

function getClientAddress(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientAddress = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0];
  return clientAddress?.trim() || req.socket?.remoteAddress || '';
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return 'Please send a valid conversation and try again.';
  }

  let totalCharacters = 0;
  for (const message of messages) {
    if (
      !message ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      message.content.trim().length === 0 ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      return `Each message must be plain text and no longer than ${MAX_MESSAGE_LENGTH} characters.`;
    }
    totalCharacters += message.content.length;
  }

  if (totalCharacters > MAX_CONVERSATION_LENGTH || messages[messages.length - 1].role !== 'user') {
    return 'Please shorten the conversation and send a new question.';
  }

  return null;
}

function getLanguageName(language) {
  if (language === undefined || language === 'en-ZA') return 'English (South African)';
  if (language === 'zu-ZA') return 'isiZulu';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    return res.status(405).json({ reply: 'Method not allowed.' });
  }

  let limitResult = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body?.messages;
    const validationError = validateMessages(messages);
    const languageName = getLanguageName(body?.language);

    if (validationError || !languageName) {
      return res.status(400).json({
        reply: validationError || 'Choose English or isiZulu and try again.',
      });
    }

    const clientAddress = getClientAddress(req);
    if (!clientAddress) {
      return res.status(503).json({ reply: 'Princess is temporarily unavailable. Please try again shortly.' });
    }

    try {
      const identifier = createHash('sha256').update(clientAddress).digest('hex');
      limitResult = await getRateLimiter().limit(identifier);
    } catch (error) {
      console.error('Princess rate limiter unavailable:', error);
      return res.status(503).json({ reply: 'Princess is temporarily unavailable. Please try again shortly.' });
    }

    const resetAt = limitResult.reset;
    const remaining = limitResult.remaining;
    if (!limitResult.success) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
      return res.status(429).json({
        reply: 'You have reached the 10-message limit for this network in the current 24-hour window. Please try again after the reset time.',
        remaining,
        resetAt,
      });
    }

    const languageInstruction = `Reply in ${languageName} by default, unless the user asks for another language.`;
    const { text } = await generateText({
      model: 'anthropic/claude-haiku-5.5',
      instructions: `${BASE_INSTRUCTIONS}\n\nLanguage preference: ${languageInstruction}`,
      messages: messages.slice(-MAX_MESSAGES),
      maxOutputTokens: 1000,
    });

    return res.status(200).json({ reply: text, remaining, resetAt });
  } catch (error) {
    console.error('Princess generation failed:', error);
    const gatewayPlanRestricted = error instanceof Error &&
      error.message.includes('Free tier users do not have access to this model');
    const response = {
      reply: gatewayPlanRestricted
        ? 'Princess’s AI service is not enabled for this project’s current Vercel AI Gateway plan. Please try again later or contact the DevMzansi site administrator.'
        : 'Princess could not reach her AI service. Please try again shortly.',
    };
    if (limitResult?.success) {
      response.remaining = limitResult.remaining;
      response.resetAt = limitResult.reset;
    }
    return res.status(gatewayPlanRestricted ? 503 : 502).json(response);
  }
}
