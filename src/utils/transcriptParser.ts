import { extractAttendeesFromTranscript } from './memberMapper.js';

/**
 * Supported transcript formats.
 */
export type TranscriptFormat = 'vtt' | 'srt' | 'plain' | 'google_meet' | 'zoom' | 'teams';

/**
 * Parsed transcript with metadata.
 */
export interface ParsedTranscript {
  content: string;
  format: TranscriptFormat;
  attendees: string[];
  duration?: string;
  startTime?: string;
}

/**
 * Detect the format of a transcript based on content patterns.
 */
export function detectTranscriptFormat(content: string): TranscriptFormat {
  const firstLines = content.split('\n').slice(0, 10).join('\n');

  // WebVTT format
  if (firstLines.includes('WEBVTT')) {
    return 'vtt';
  }

  // SRT format (numbered entries with timestamps)
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/m.test(firstLines)) {
    return 'srt';
  }

  // Google Meet format (usually has specific patterns)
  if (firstLines.includes('Google Meet') || /^\d{1,2}:\d{2}:\d{2}\s+[A-Z][a-z]+/.test(firstLines)) {
    return 'google_meet';
  }

  // Zoom format
  if (firstLines.includes('ZOOM') || /^From\s+.+\s+to\s+Everyone:/m.test(content)) {
    return 'zoom';
  }

  // Teams format
  if (firstLines.includes('Microsoft Teams') || /^\d{1,2}:\d{2}\s+(AM|PM)\s+[A-Z][a-z]+/m.test(firstLines)) {
    return 'teams';
  }

  return 'plain';
}

/**
 * Parse a transcript and extract clean text content.
 */
export function parseTranscript(rawContent: string): ParsedTranscript {
  const format = detectTranscriptFormat(rawContent);

  let content: string;
  switch (format) {
    case 'vtt':
      content = parseVTT(rawContent);
      break;
    case 'srt':
      content = parseSRT(rawContent);
      break;
    case 'google_meet':
      content = parseGoogleMeet(rawContent);
      break;
    case 'zoom':
      content = parseZoom(rawContent);
      break;
    case 'teams':
      content = parseTeams(rawContent);
      break;
    default:
      content = cleanPlainTranscript(rawContent);
  }

  const attendees = extractAttendeesFromTranscript(content);

  return {
    content,
    format,
    attendees
  };
}

/**
 * Parse WebVTT format.
 */
function parseVTT(content: string): string {
  const lines = content.split('\n');
  const textLines: string[] = [];

  let inCue = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip header and empty lines
    if (trimmed === 'WEBVTT' || trimmed === '' || trimmed.startsWith('NOTE')) {
      inCue = false;
      continue;
    }

    // Skip timestamp lines
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/.test(trimmed)) {
      inCue = true;
      continue;
    }

    // Skip cue identifiers (lines that are just numbers or IDs)
    if (/^\d+$/.test(trimmed)) {
      continue;
    }

    // Add text content
    if (inCue || (!isTimestampLine(trimmed) && trimmed.length > 0)) {
      // Remove VTT tags like <v Speaker>
      const cleanedLine = trimmed.replace(/<[^>]+>/g, '');
      if (cleanedLine.length > 0) {
        textLines.push(cleanedLine);
      }
    }
  }

  return textLines.join('\n');
}

/**
 * Parse SRT format.
 */
function parseSRT(content: string): string {
  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip sequence numbers
    if (/^\d+$/.test(trimmed)) {
      continue;
    }

    // Skip timestamp lines
    if (/^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(trimmed)) {
      continue;
    }

    // Skip empty lines
    if (trimmed === '') {
      continue;
    }

    // Add text content
    textLines.push(trimmed);
  }

  return textLines.join('\n');
}

/**
 * Parse Google Meet transcript format.
 */
function parseGoogleMeet(content: string): string {
  // Google Meet often has format: "HH:MM:SS Speaker Name"
  // We want to convert to "Speaker Name: text"
  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Match timestamp followed by speaker
    const match = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
    if (match) {
      // Check if it's speaker: text or speaker with text on next line
      const afterTimestamp = match[2];
      if (afterTimestamp.includes(':')) {
        textLines.push(afterTimestamp);
      } else {
        // Might be just the speaker name, or speaker with text
        textLines.push(`${afterTimestamp}:`);
      }
    } else if (trimmed && !isTimestampLine(trimmed)) {
      textLines.push(trimmed);
    }
  }

  return textLines.join('\n');
}

/**
 * Parse Zoom transcript format.
 */
function parseZoom(content: string): string {
  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip Zoom metadata lines
    if (trimmed.startsWith('ZOOM') || trimmed.startsWith('Recording')) {
      continue;
    }

    // Handle "From X to Everyone:" chat format
    const chatMatch = trimmed.match(/^From\s+(.+?)\s+to\s+.+?:\s*(.*)$/);
    if (chatMatch) {
      textLines.push(`${chatMatch[1]}: ${chatMatch[2]}`);
      continue;
    }

    // Regular transcript lines
    if (trimmed && !isTimestampLine(trimmed)) {
      textLines.push(trimmed);
    }
  }

  return textLines.join('\n');
}

/**
 * Parse Microsoft Teams transcript format.
 */
function parseTeams(content: string): string {
  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip Teams metadata
    if (trimmed.includes('Microsoft Teams') || trimmed.includes('Meeting recording')) {
      continue;
    }

    // Match Teams format: "HH:MM AM/PM Speaker Name"
    const match = trimmed.match(/^(\d{1,2}:\d{2})\s*(AM|PM)?\s*(.+)$/i);
    if (match) {
      const afterTimestamp = match[3];
      textLines.push(afterTimestamp);
    } else if (trimmed && !isTimestampLine(trimmed)) {
      textLines.push(trimmed);
    }
  }

  return textLines.join('\n');
}

/**
 * Clean plain text transcript.
 */
function cleanPlainTranscript(content: string): string {
  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and pure timestamp lines
    if (trimmed === '' || isTimestampLine(trimmed)) {
      continue;
    }

    // Remove leading timestamps from lines
    const cleanedLine = trimmed.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, '');

    if (cleanedLine.length > 0) {
      textLines.push(cleanedLine);
    }
  }

  return textLines.join('\n');
}

/**
 * Check if a line is primarily a timestamp.
 */
function isTimestampLine(line: string): boolean {
  const trimmed = line.trim();
  // Match various timestamp formats
  return (
    /^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i.test(trimmed) ||
    /^\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(trimmed) ||
    /^\[\d{1,2}:\d{2}(:\d{2})?\]$/.test(trimmed)
  );
}

/**
 * Extract meeting duration from transcript metadata.
 */
export function extractDuration(content: string): string | null {
  // Look for duration patterns
  const patterns = [
    /Duration:\s*(\d+:\d{2}(?::\d{2})?)/i,
    /Length:\s*(\d+:\d{2}(?::\d{2})?)/i,
    /(\d+)\s*(?:hour|hr)s?\s*(?:and\s*)?(\d+)\s*(?:minute|min)s?/i
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Normalize speaker names in transcript for consistency.
 */
export function normalizeSpeakerNames(content: string): string {
  // Create a map of variations to canonical names
  const speakerVariations = new Map<string, string>();

  // Find all speaker patterns
  const speakerPattern = /^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?):?/gm;
  let match;

  while ((match = speakerPattern.exec(content)) !== null) {
    const speaker = match[1].trim();
    const canonical = speaker.split(' ')[0]; // Use first name as canonical

    // Map full names to first names if we've seen the first name alone
    if (speaker.includes(' ') && !speakerVariations.has(speaker)) {
      speakerVariations.set(speaker, canonical);
    }
  }

  // Apply normalization (optional - depends on use case)
  let normalized = content;
  for (const [variation, canonical] of speakerVariations) {
    // Only normalize if needed
    // normalized = normalized.replace(new RegExp(variation + ':', 'g'), canonical + ':');
  }

  return normalized;
}
