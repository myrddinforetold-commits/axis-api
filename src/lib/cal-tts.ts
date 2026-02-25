const ELEVENLABS_API_KEY = process.env.CAL_ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_BASE_URL = (process.env.CAL_ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const ELEVENLABS_VOICE_ID = process.env.CAL_ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const ELEVENLABS_MODEL_ID = process.env.CAL_ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const ELEVENLABS_OUTPUT_FORMAT = process.env.CAL_ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';

const OPENAI_API_KEY = process.env.CAL_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const OPENAI_TTS_MODEL = process.env.CAL_OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.CAL_OPENAI_TTS_VOICE || 'alloy';

export interface CalTtsResult {
  provider: 'elevenlabs' | 'openai';
  mimeType: string;
  audio: Buffer;
}

function sanitizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function ensureAudioResponse(response: Response, body: ArrayBuffer): Buffer {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('audio')) {
    throw new Error(`Unexpected TTS response content-type: ${contentType || 'unknown'}`);
  }
  return Buffer.from(body);
}

async function tryElevenLabs(text: string, voiceId?: string): Promise<CalTtsResult> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY missing');
  }

  const targetVoiceId = (voiceId || ELEVENLABS_VOICE_ID).trim();
  const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(targetVoiceId)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL_ID,
      output_format: ELEVENLABS_OUTPUT_FORMAT,
      optimize_streaming_latency: 2,
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 400);
    throw new Error(`ElevenLabs error ${response.status}: ${details}`);
  }

  const buffer = ensureAudioResponse(response, await response.arrayBuffer());
  return {
    provider: 'elevenlabs',
    mimeType: response.headers.get('content-type') || 'audio/mpeg',
    audio: buffer,
  };
}

async function tryOpenAi(text: string): Promise<CalTtsResult> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 400);
    throw new Error(`OpenAI TTS error ${response.status}: ${details}`);
  }

  const buffer = ensureAudioResponse(response, await response.arrayBuffer());
  return {
    provider: 'openai',
    mimeType: response.headers.get('content-type') || 'audio/mpeg',
    audio: buffer,
  };
}

export async function synthesizeCalSpeech(input: {
  text: string;
  voiceId?: string;
}): Promise<CalTtsResult> {
  const text = sanitizeText(input.text || '');
  if (!text) throw new Error('text is required');
  if (text.length > 2000) throw new Error('text is too long (max 2000 chars)');

  try {
    return await tryElevenLabs(text, input.voiceId);
  } catch (elevenError) {
    try {
      return await tryOpenAi(text);
    } catch (openaiError) {
      const message = [
        'TTS failed on all providers.',
        `ElevenLabs: ${elevenError instanceof Error ? elevenError.message : String(elevenError)}`,
        `OpenAI: ${openaiError instanceof Error ? openaiError.message : String(openaiError)}`,
      ].join(' ');
      throw new Error(message);
    }
  }
}
