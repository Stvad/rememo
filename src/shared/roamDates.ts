const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ROAM_DATE_RE = /^([A-Za-z]+)\s+(\d{1,2})(st|nd|rd|th),\s+(\d{4})$/;

const getOrdinal = (day: number) => {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';

  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
};

export const parseRoamDateString = (roamDateString: string): Date => {
  const normalized = roamDateString.trim();
  const match = normalized.match(ROAM_DATE_RE);

  if (!match) return new Date(NaN);

  const [, monthName, dayString, , yearString] = match;
  const monthIndex = MONTH_NAMES.indexOf(monthName);

  if (monthIndex === -1) return new Date(NaN);

  return new Date(Number(yearString), monthIndex, Number(dayString));
};

export const dateToRoamDateString = (date: Date) => {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();

  return `${monthName} ${day}${getOrdinal(day)}, ${date.getFullYear()}`;
};
