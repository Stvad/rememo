import { savePracticeData } from '~/queries';
import { Session } from '~/models/session';
import { generatePracticeData, supermemo } from '~/shared/review';

export { generatePracticeData, supermemo };

export type PracticeProps = Session & {
  refUid: string;
  dataPageTitle: string;
  isCramming?: boolean;
};

const practice = async (practiceProps: PracticeProps, isDryRun = false) => {
  const {
    refUid,
    dataPageTitle,
    dateCreated = null,
    isCramming,
    grade,
    interval,
    repetitions,
    eFactor,
    intervalMultiplier,
    intervalMultiplierType,
    reviewMode,
  } = practiceProps;

  // Just destructuring nextDueDateFromNow here because I don't want to store it
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { nextDueDateFromNow, ...practiceResultData } = generatePracticeData({
    grade,
    interval,
    repetitions,
    eFactor,
    dateCreated,
    reviewMode,
    intervalMultiplier,
    intervalMultiplierType,
  });

  if (!isDryRun && !isCramming) {
    await savePracticeData({
      refUid: refUid,
      dataPageTitle,
      dateCreated,
      ...practiceResultData,
    });
  }

  return practiceResultData;
};

export default practice;
