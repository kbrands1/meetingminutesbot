import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { MeetingAnalysisSchema, type MeetingAnalysis } from '../schemas/taskSchema.js';
import type { MeetingInfo, ExtractedTask } from '../types/index.js';
import { getOpenAIApiKey, appConfig } from '../config/index.js';
import { resolveDateExpression } from '../utils/dateResolver.js';

const MAX_TOKENS_PER_CHUNK = 100000; // GPT-4o context is 128k, leave room for response
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_CHARS_PER_CHUNK = MAX_TOKENS_PER_CHUNK * CHARS_PER_TOKEN_ESTIMATE;

function getOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: getOpenAIApiKey()
  });
}

/**
 * System prompt for task extraction.
 */
const SYSTEM_PROMPT = `You are an expert meeting analyst who extracts actionable tasks from meeting transcripts. Your job is to identify both explicit task callouts and implicit action items.

## Explicit Task Patterns (confidence: 1.0)
These patterns indicate someone is explicitly creating a task:
- "Create task [name] for [person] due [date]"
- "Task for [person]: [description] by [date]"
- "Action item: [task] assigned to [person]"
- "[Person], can you [task] by [date]"
- "Adding a task - [person] to [task]"
- "Let's make that a task for [person]"
- "That's a task for [person], due [date]"
- "I'll take an action item to [task]"
- "Can we add a task for [description]"

## Implicit Task Detection (confidence: varies)
These are commitments made naturally in conversation:
- "[Person] will [action]" or "I'll [action]"
- "Let me follow up on [topic]"
- Promises or commitments: "I can have that ready by..."
- Clear next steps discussed: "The next step is..."
- Requests with deadlines: "We need this done by..."

## Priority Guidelines
- URGENT: Uses words like "urgent", "ASAP", "critical", "immediately", "blocker"
- HIGH: Important but not urgent, uses "important", "priority", "soon"
- NORMAL: Standard tasks without urgency indicators
- LOW: Nice to have, "when you get a chance", "eventually", "low priority"

## Date Resolution
When dates are mentioned relatively, resolve them based on the meeting date provided.
Return dates in ISO 8601 format (YYYY-MM-DD).

## Important Guidelines
1. Extract the exact quote where the task was identified
2. Be specific about assignees - use names exactly as mentioned
3. For explicit callouts, always set confidence to 1.0
4. For implicit tasks, set confidence based on how clear the commitment is
5. Don't create duplicate tasks - consolidate if the same task is mentioned multiple times
6. Focus on actionable items, not general discussions or observations`;

/**
 * Extract tasks from a meeting transcript using OpenAI.
 */
export async function extractTasks(
  transcriptContent: string,
  meetingInfo: MeetingInfo
): Promise<MeetingAnalysis> {
  const openai = getOpenAIClient();

  // Check if content needs chunking
  if (transcriptContent.length > MAX_CHARS_PER_CHUNK) {
    return await extractTasksFromChunks(transcriptContent, meetingInfo);
  }

  const userPrompt = buildUserPrompt(transcriptContent, meetingInfo);

  try {
    const completion = await openai.beta.chat.completions.parse({
      model: appConfig.openai.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      response_format: zodResponseFormat(MeetingAnalysisSchema, 'meeting_analysis'),
      temperature: 0.2
    });

    const result = completion.choices[0].message.parsed;
    if (!result) {
      throw new Error('Failed to parse OpenAI response');
    }

    // Post-process dates
    return postProcessAnalysis(result, meetingInfo.date);
  } catch (error) {
    console.error('Error with primary model, trying fallback:', error);
    return await extractTasksWithFallback(transcriptContent, meetingInfo);
  }
}

/**
 * Build the user prompt with meeting context.
 */
function buildUserPrompt(transcript: string, meetingInfo: MeetingInfo): string {
  return `Analyze the following meeting transcript and extract all tasks.

## Meeting Information
- Title: ${meetingInfo.title}
- Date: ${meetingInfo.date}
- Source Folder: ${meetingInfo.folderName}
- Attendees: ${meetingInfo.attendees.length > 0 ? meetingInfo.attendees.join(', ') : 'Not specified'}

## Transcript
${transcript}

Please identify all explicit task callouts and implicit action items. For each task, provide the title, description, suggested assignee, due date (if mentioned), priority, the exact source quote, your confidence level, and whether it was explicit or implicit.`;
}

/**
 * Extract tasks from long transcripts by splitting into chunks.
 */
async function extractTasksFromChunks(
  transcriptContent: string,
  meetingInfo: MeetingInfo
): Promise<MeetingAnalysis> {
  const chunks = splitTranscriptIntoChunks(transcriptContent);
  console.log(`Splitting transcript into ${chunks.length} chunks for processing`);

  const chunkResults: MeetingAnalysis[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1}/${chunks.length}`);
    const chunkMeetingInfo = {
      ...meetingInfo,
      title: `${meetingInfo.title} (Part ${i + 1}/${chunks.length})`
    };

    const result = await extractTasks(chunks[i], chunkMeetingInfo);
    chunkResults.push(result);

    // Add delay between chunks to avoid rate limits
    if (i < chunks.length - 1) {
      await sleep(1000);
    }
  }

  return mergeChunkResults(chunkResults);
}

/**
 * Split transcript into chunks at speaker boundaries.
 */
function splitTranscriptIntoChunks(transcript: string): string[] {
  const chunks: string[] = [];
  const lines = transcript.split('\n');
  let currentChunk = '';

  // Pattern to detect speaker changes (e.g., "John:", "[John]", "JOHN:")
  const speakerPattern = /^(?:\[[\w\s]+\]|[\w\s]+:)/;

  for (const line of lines) {
    const lineWithNewline = line + '\n';

    // If adding this line would exceed the limit
    if (currentChunk.length + lineWithNewline.length > MAX_CHARS_PER_CHUNK) {
      // If current line is a speaker change, it's a good split point
      if (speakerPattern.test(line) && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = lineWithNewline;
      } else {
        // Otherwise, push current chunk and start new one
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = lineWithNewline;
      }
    } else {
      currentChunk += lineWithNewline;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Merge results from multiple chunks, deduplicating tasks.
 */
function mergeChunkResults(results: MeetingAnalysis[]): MeetingAnalysis {
  const allTasks: ExtractedTask[] = [];
  const allDecisions: string[] = [];
  const summaries: string[] = [];

  for (const result of results) {
    allTasks.push(...result.tasks);
    allDecisions.push(...result.decisions);
    summaries.push(result.meeting_summary);
  }

  // Deduplicate tasks based on title similarity
  const deduplicatedTasks = deduplicateTasks(allTasks);

  // Deduplicate decisions
  const uniqueDecisions = [...new Set(allDecisions)];

  // Combine summaries
  const combinedSummary = summaries.length === 1
    ? summaries[0]
    : `Meeting covered multiple topics. ${summaries.join(' ')}`;

  return {
    tasks: deduplicatedTasks,
    meeting_summary: combinedSummary,
    decisions: uniqueDecisions
  };
}

/**
 * Deduplicate tasks based on title similarity.
 */
function deduplicateTasks(tasks: ExtractedTask[]): ExtractedTask[] {
  const seen = new Map<string, ExtractedTask>();

  for (const task of tasks) {
    const normalizedTitle = task.title.toLowerCase().trim();

    // Check for similar existing task
    let isDuplicate = false;
    for (const [existingTitle, existingTask] of seen) {
      if (areTitlesSimilar(normalizedTitle, existingTitle)) {
        // Keep the one with higher confidence or explicit over implicit
        if (
          task.confidence > existingTask.confidence ||
          (task.extraction_type === 'explicit' && existingTask.extraction_type === 'implicit')
        ) {
          seen.delete(existingTitle);
          seen.set(normalizedTitle, task);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      seen.set(normalizedTitle, task);
    }
  }

  return Array.from(seen.values());
}

/**
 * Check if two task titles are similar enough to be duplicates.
 */
function areTitlesSimilar(title1: string, title2: string): boolean {
  // Simple similarity check - could be improved with Levenshtein distance
  if (title1 === title2) return true;

  // Check if one contains the other
  if (title1.includes(title2) || title2.includes(title1)) return true;

  // Check word overlap
  const words1 = new Set(title1.split(/\s+/));
  const words2 = new Set(title2.split(/\s+/));
  const overlap = [...words1].filter(w => words2.has(w)).length;
  const minLength = Math.min(words1.size, words2.size);

  return minLength > 0 && overlap / minLength > 0.7;
}

/**
 * Post-process the analysis to resolve dates.
 */
function postProcessAnalysis(
  analysis: MeetingAnalysis,
  meetingDate: string
): MeetingAnalysis {
  const processedTasks = analysis.tasks.map(task => {
    if (task.suggested_due && !isISODate(task.suggested_due)) {
      // Try to resolve relative date expressions
      const resolvedDate = resolveDateExpression(task.suggested_due, meetingDate);
      return { ...task, suggested_due: resolvedDate };
    }
    return task;
  });

  return {
    ...analysis,
    tasks: processedTasks
  };
}

/**
 * Check if a string is already in ISO date format.
 */
function isISODate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * Fallback to a smaller model if the primary fails.
 */
async function extractTasksWithFallback(
  transcriptContent: string,
  meetingInfo: MeetingInfo
): Promise<MeetingAnalysis> {
  const openai = getOpenAIClient();
  const userPrompt = buildUserPrompt(transcriptContent, meetingInfo);

  const completion = await openai.beta.chat.completions.parse({
    model: appConfig.openai.fallbackModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    response_format: zodResponseFormat(MeetingAnalysisSchema, 'meeting_analysis'),
    temperature: 0.2
  });

  const result = completion.choices[0].message.parsed;
  if (!result) {
    throw new Error('Failed to parse fallback model response');
  }

  return postProcessAnalysis(result, meetingInfo.date);
}

/**
 * Simple sleep utility for rate limiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
