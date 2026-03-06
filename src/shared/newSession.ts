import { IntervalMultiplierType, NewSession, ReviewModes } from '~/models/session';

export const generateNewSession = ({
  reviewMode = ReviewModes.DefaultSpacedInterval,
  dateCreated = undefined,
  isNew = true,
} = {}): NewSession => {
  if (reviewMode === ReviewModes.DefaultSpacedInterval) {
    return {
      dateCreated: dateCreated || new Date(),
      eFactor: 2.5,
      interval: 0,
      repetitions: 0,
      isNew,
      reviewMode,
    };
  }

  return {
    dateCreated: dateCreated || new Date(),
    intervalMultiplier: 3,
    intervalMultiplierType: IntervalMultiplierType.Days,
    isNew,
    reviewMode,
  };
};
