import { z } from 'zod';

/**
 * Schema for a single extracted task from a meeting transcript.
 */
export const TaskSchema = z.object({
  title: z.string().describe('Clear, actionable task title'),
  description: z.string().describe('Detailed description of what needs to be done'),
  suggested_assignee: z.string().nullable().describe('Name of the person who should be assigned this task, or null if unclear'),
  suggested_due: z.string().nullable().describe('Suggested due date in ISO 8601 format (YYYY-MM-DD), or null if not mentioned'),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).describe('Task priority based on context and language used'),
  source_quote: z.string().describe('Exact quote from the transcript where this task was identified'),
  confidence: z.number().min(0).max(1).describe('Confidence score from 0 to 1. Explicit callouts should always be 1.0'),
  extraction_type: z.enum(['explicit', 'implicit']).describe('Whether this was explicitly stated as a task or inferred from conversation')
});

/**
 * Schema for the complete meeting analysis response.
 */
export const MeetingAnalysisSchema = z.object({
  tasks: z.array(TaskSchema).describe('List of extracted tasks from the meeting'),
  meeting_summary: z.string().describe('Brief summary of the meeting in 2-3 sentences'),
  decisions: z.array(z.string()).describe('Key decisions made during the meeting')
});

/**
 * Schema for task extraction request context.
 */
export const MeetingContextSchema = z.object({
  title: z.string().describe('Meeting title'),
  date: z.string().describe('Meeting date in ISO format'),
  attendees: z.array(z.string()).describe('List of attendees'),
  folderName: z.string().describe('Name of the source folder for context')
});

// Export types derived from schemas
export type Task = z.infer<typeof TaskSchema>;
export type MeetingAnalysis = z.infer<typeof MeetingAnalysisSchema>;
export type MeetingContext = z.infer<typeof MeetingContextSchema>;
