import { IntervalMultiplierType, ReviewModes, Session } from '~/models/session';
import { addDays, customFromNow } from '~/utils/date';

export const supermemo = (
  item: { interval: number; repetition: number; efactor: number },
  grade: number
) => {
  let nextInterval;
  let nextRepetition;
  let nextEfactor;

  if (grade === 0) {
    nextInterval = 0;
    nextRepetition = 0;
    // todo: Note this is different from the roam/memo, adjusting this to work closer to how the roam-toolkit implementation works
  } else if (grade < 2) {
    nextInterval = 1;
    nextRepetition = 0;
  } else {
    if (item.repetition === 0) {
      nextInterval = 1;
      nextRepetition = 1;
    } else if (item.repetition === 1) {
      nextInterval = 6;
      nextRepetition = 2;
    } else {
      nextInterval = Math.round(item.interval * item.efactor * (grade / 5));
      nextRepetition = item.repetition + 1;
    }
  }

  nextEfactor = item.efactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));

  if (nextEfactor < 1.3) nextEfactor = 1.3;

  return {
    interval: nextInterval,
    repetition: nextRepetition,
    efactor: nextEfactor,
  };
};

export type PracticeDataResult = Session & {
  nextDueDateFromNow?: string;
};

export const generatePracticeData = ({
  dateCreated,
  reviewMode,
  ...props
}: Session): PracticeDataResult => {
  const shared = {
    reviewMode,
  };

  if (reviewMode === ReviewModes.FixedInterval) {
    const { intervalMultiplier, intervalMultiplierType } = props;
    const today = new Date();
    let nextDueDate: Date | undefined;
    if (intervalMultiplierType === IntervalMultiplierType.Days) {
      nextDueDate = addDays(today, intervalMultiplier as number);
    } else if (intervalMultiplierType === IntervalMultiplierType.Weeks) {
      nextDueDate = addDays(today, (intervalMultiplier as number) * 7);
    } else if (intervalMultiplierType === IntervalMultiplierType.Months) {
      nextDueDate = addDays(today, (intervalMultiplier as number) * 30);
    } else if (intervalMultiplierType === IntervalMultiplierType.Years) {
      nextDueDate = addDays(today, (intervalMultiplier as number) * 365);
    }

    return {
      ...shared,
      reviewMode: ReviewModes.FixedInterval,
      intervalMultiplier,
      intervalMultiplierType,
      nextDueDate,
      nextDueDateFromNow: nextDueDate ? customFromNow(nextDueDate) : undefined,
    };
  } else {
    const { grade, interval, repetitions, eFactor } = props;
    const supermemoResults = supermemo(
      {
        interval: interval as number,
        repetition: repetitions as number,
        efactor: eFactor as number,
      },
      grade as number
    );

    const nextDueDate = addDays(dateCreated as Date, supermemoResults.interval);

    return {
      ...shared,
      reviewMode: ReviewModes.DefaultSpacedInterval,
      grade,
      repetitions: supermemoResults.repetition,
      interval: supermemoResults.interval,
      eFactor: supermemoResults.efactor,
      dateCreated,
      nextDueDate,
      nextDueDateFromNow: customFromNow(nextDueDate),
    };
  }
};
