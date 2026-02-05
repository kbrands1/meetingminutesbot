import {
  parseISO,
  addDays,
  addWeeks,
  nextFriday,
  endOfWeek,
  endOfMonth,
  startOfMonth,
  addMonths,
  format,
  getDay,
  setDay,
  isValid
} from 'date-fns';

/**
 * Resolve relative date expressions to ISO format dates.
 *
 * Examples:
 * - "tomorrow" → meeting date + 1
 * - "next Friday" → next occurring Friday
 * - "end of week" → Friday of meeting week
 * - "in two weeks" → meeting date + 14
 * - "end of month" → last day of month
 * - "Q1" → March 31
 */
export function resolveDateExpression(
  expression: string,
  meetingDateStr: string
): string | null {
  const meetingDate = parseISO(meetingDateStr);
  if (!isValid(meetingDate)) {
    console.warn(`Invalid meeting date: ${meetingDateStr}`);
    return null;
  }

  const normalizedExpr = expression.toLowerCase().trim();

  // Check for patterns and resolve
  const resolvers: Array<{
    pattern: RegExp;
    resolve: (match: RegExpMatchArray) => Date;
  }> = [
    // Tomorrow
    {
      pattern: /^tomorrow$/,
      resolve: () => addDays(meetingDate, 1)
    },
    // Next [day of week]
    {
      pattern: /^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/,
      resolve: (match) => getNextDayOfWeek(meetingDate, match[1])
    },
    // This [day of week]
    {
      pattern: /^this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/,
      resolve: (match) => getThisDayOfWeek(meetingDate, match[1])
    },
    // End of week / EOW
    {
      pattern: /^(end\s+of\s+week|eow)$/,
      resolve: () => nextFriday(meetingDate)
    },
    // End of month / EOM
    {
      pattern: /^(end\s+of\s+month|eom)$/,
      resolve: () => endOfMonth(meetingDate)
    },
    // End of quarter / EOQ
    {
      pattern: /^(end\s+of\s+quarter|eoq)$/,
      resolve: () => getEndOfQuarter(meetingDate)
    },
    // In X days
    {
      pattern: /^in\s+(\d+)\s+days?$/,
      resolve: (match) => addDays(meetingDate, parseInt(match[1], 10))
    },
    // In X weeks
    {
      pattern: /^in\s+(\d+)\s+weeks?$/,
      resolve: (match) => addWeeks(meetingDate, parseInt(match[1], 10))
    },
    // In a week
    {
      pattern: /^in\s+a\s+week$/,
      resolve: () => addWeeks(meetingDate, 1)
    },
    // In two weeks
    {
      pattern: /^in\s+two\s+weeks$/,
      resolve: () => addWeeks(meetingDate, 2)
    },
    // Next week
    {
      pattern: /^next\s+week$/,
      resolve: () => addWeeks(meetingDate, 1)
    },
    // Q1, Q2, Q3, Q4
    {
      pattern: /^q([1-4])$/,
      resolve: (match) => getQuarterEndDate(meetingDate, parseInt(match[1], 10))
    },
    // ASAP / immediately (default to tomorrow)
    {
      pattern: /^(asap|immediately|right\s+away|urgent)$/,
      resolve: () => addDays(meetingDate, 1)
    },
    // By [day]
    {
      pattern: /^by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/,
      resolve: (match) => getNextDayOfWeek(meetingDate, match[1])
    },
    // Month name (e.g., "by March", "in April")
    {
      pattern: /^(?:by|in)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)$/,
      resolve: (match) => getEndOfMonth(meetingDate, match[1])
    }
  ];

  for (const { pattern, resolve } of resolvers) {
    const match = normalizedExpr.match(pattern);
    if (match) {
      const resolvedDate = resolve(match);
      return format(resolvedDate, 'yyyy-MM-dd');
    }
  }

  // If no pattern matches, return null (the original might already be a date)
  return null;
}

/**
 * Get the day of week index (0 = Sunday, 1 = Monday, etc.)
 */
function getDayIndex(dayName: string): number {
  const days: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  return days[dayName.toLowerCase()] ?? 0;
}

/**
 * Get the next occurrence of a day of week.
 */
function getNextDayOfWeek(fromDate: Date, dayName: string): Date {
  const targetDay = getDayIndex(dayName);
  const currentDay = getDay(fromDate);
  let daysToAdd = targetDay - currentDay;

  // If it's the same day or earlier in the week, go to next week
  if (daysToAdd <= 0) {
    daysToAdd += 7;
  }

  return addDays(fromDate, daysToAdd);
}

/**
 * Get this week's occurrence of a day (could be past).
 */
function getThisDayOfWeek(fromDate: Date, dayName: string): Date {
  const targetDay = getDayIndex(dayName);
  return setDay(fromDate, targetDay, { weekStartsOn: 1 });
}

/**
 * Get the end of the current quarter.
 */
function getEndOfQuarter(date: Date): Date {
  const month = date.getMonth();
  const quarterMonth = Math.floor(month / 3) * 3 + 2; // 2 = Q1, 5 = Q2, 8 = Q3, 11 = Q4
  const quarterEndMonth = startOfMonth(new Date(date.getFullYear(), quarterMonth, 1));
  return endOfMonth(quarterEndMonth);
}

/**
 * Get the end date of a specific quarter in the relevant year.
 */
function getQuarterEndDate(referenceDate: Date, quarter: number): Date {
  const year = referenceDate.getFullYear();
  const quarterEndMonths: Record<number, number> = {
    1: 2,  // Q1 ends March
    2: 5,  // Q2 ends June
    3: 8,  // Q3 ends September
    4: 11  // Q4 ends December
  };

  const endMonth = quarterEndMonths[quarter];
  let targetYear = year;

  // If the quarter has already passed this year, use next year
  if (endMonth < referenceDate.getMonth()) {
    targetYear = year + 1;
  }

  return endOfMonth(new Date(targetYear, endMonth, 1));
}

/**
 * Get the end of a specific month.
 */
function getEndOfMonth(referenceDate: Date, monthName: string): Date {
  const months: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };

  const targetMonth = months[monthName.toLowerCase()];
  let targetYear = referenceDate.getFullYear();

  // If the month has passed, use next year
  if (targetMonth < referenceDate.getMonth()) {
    targetYear += 1;
  }

  return endOfMonth(new Date(targetYear, targetMonth, 1));
}

/**
 * Parse a date string that might be in various formats.
 */
export function parseFlexibleDate(dateStr: string): Date | null {
  // Try ISO format first
  const isoDate = parseISO(dateStr);
  if (isValid(isoDate)) {
    return isoDate;
  }

  // Try common formats
  const formats = [
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/, // MM/DD/YYYY or M/D/YY
    /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/,   // MM-DD-YYYY
  ];

  for (const pattern of formats) {
    const match = dateStr.match(pattern);
    if (match) {
      const month = parseInt(match[1], 10) - 1;
      const day = parseInt(match[2], 10);
      let year = parseInt(match[3], 10);
      if (year < 100) {
        year += 2000;
      }
      const date = new Date(year, month, day);
      if (isValid(date)) {
        return date;
      }
    }
  }

  return null;
}
