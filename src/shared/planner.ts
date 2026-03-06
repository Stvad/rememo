import * as dateUtils from '~/utils/date';
import * as objectUtils from '~/utils/object';
import { CompleteRecords, RecordUid, Session } from '~/models/session';
import { CompletionStatus, RenderMode, Today, TodayInitial } from '~/models/practice';
import { generateNewSession } from '~/shared/newSession';

export const initializeToday = ({ tagsList, cachedData }) => {
  const today: Today = objectUtils.deepClone(TodayInitial);

  for (const tag of tagsList) {
    const cachedTagData = cachedData?.[tag];

    today.tags[tag] = {
      status: CompletionStatus.Unstarted,
      completed: 0,
      due: 0,
      new: 0,
      newUids: [],
      dueUids: [],
      completedUids: [],
      completedDue: 0,
      completedNew: 0,
      completedDueUids: [],
      completedNewUids: [],
      renderMode: cachedTagData?.renderMode || RenderMode.Normal,
    };
  }

  return today;
};

export const calculateTodayStatus = ({ today, tagsList }) => {
  for (const tag of tagsList) {
    const completed = today.tags[tag].completed;
    const remaining = today.tags[tag].new + today.tags[tag].due;

    if (remaining === 0) {
      today.tags[tag].status = CompletionStatus.Finished;
    } else if (completed > 0) {
      today.tags[tag].status = CompletionStatus.Partial;
    } else {
      today.tags[tag].status = CompletionStatus.Unstarted;
    }
  }

  const completed = today.combinedToday.completed;
  const remaining = today.combinedToday.new + today.combinedToday.due;

  if (remaining === 0) {
    today.combinedToday.status = CompletionStatus.Finished;
  } else if (completed > 0) {
    today.combinedToday.status = CompletionStatus.Partial;
  } else {
    today.combinedToday.status = CompletionStatus.Unstarted;
  }
};

export const calculateCompletedTodayCounts = ({ today, tagsList, sessionData }) => {
  for (const tag of tagsList) {
    let count = 0;
    const completedUids: string[] = [];
    const completedDueUids: string[] = [];
    const completedNewUids: string[] = [];

    const currentTagSessionData = sessionData[tag];
    Object.keys(currentTagSessionData).forEach((cardUid) => {
      const cardData = currentTagSessionData[cardUid];
      const latestSession = cardData[cardData.length - 1];
      const isCompletedToday =
        latestSession && dateUtils.isSameDay(latestSession.dateCreated, new Date());

      if (isCompletedToday) {
        const isFirstSession = cardData.length === 1;

        count++;
        completedUids.push(cardUid);
        if (!isFirstSession) completedDueUids.push(cardUid);
        if (isFirstSession) completedNewUids.push(cardUid);
      }
    });

    today.tags[tag] = {
      ...(today.tags[tag] || {}),
      completed: count,
      completedUids,
      completedDueUids,
      completedNewUids,
      completedDue: completedDueUids.length,
      completedNew: completedNewUids.length,
    };
  }

  return today;
};

export const calculateCombinedCounts = ({ today, tagsList }) => {
  const todayInitial: Today = objectUtils.deepClone(TodayInitial);

  today.combinedToday = todayInitial.combinedToday;

  for (const tag of tagsList) {
    today.combinedToday.due += today.tags[tag].due;
    today.combinedToday.new += today.tags[tag].new;
    today.combinedToday.dueUids = today.combinedToday.dueUids.concat(today.tags[tag].dueUids);
    today.combinedToday.newUids = today.combinedToday.newUids.concat(today.tags[tag].newUids);
    today.combinedToday.completed += today.tags[tag].completed;
    today.combinedToday.completedUids = today.combinedToday.completedUids.concat(
      today.tags[tag].completedUids
    );
    today.combinedToday.completedDue += today.tags[tag].completedDue;
    today.combinedToday.completedDueUids = today.combinedToday.completedDueUids.concat(
      today.tags[tag].completedDueUids
    );
    today.combinedToday.completedNew += today.tags[tag].completedNew;
    today.combinedToday.completedNewUids = today.combinedToday.completedNewUids.concat(
      today.tags[tag].completedNewUids
    );
  }
};

export const addNewCards = ({
  today,
  tagsList,
  cardUids,
  pluginPageData,
  shuffleCards,
}: {
  today: Today;
  tagsList: string[];
  cardUids: Record<string, RecordUid[]>;
  pluginPageData: CompleteRecords;
  shuffleCards: boolean;
}) => {
  for (const currentTag of tagsList) {
    const allSelectedTagCardsUids = cardUids[currentTag];
    const newCardsUids: RecordUid[] = [];

    allSelectedTagCardsUids.forEach((referenceId) => {
      if (!pluginPageData[referenceId] || !pluginPageData[referenceId].length) {
        newCardsUids.push(referenceId);
        pluginPageData[referenceId] = [generateNewSession()];
      }
    });

    if (shuffleCards) {
      newCardsUids.sort(() => Math.random() - 0.5);
    } else {
      newCardsUids.reverse();
    }

    today.tags[currentTag] = {
      ...today.tags[currentTag],
      newUids: newCardsUids,
      new: newCardsUids.length,
    };
  }
};

export const getDueCardUids = (currentTagSessionData: CompleteRecords, isCramming: boolean) => {
  const results: RecordUid[] = [];
  if (!Object.keys(currentTagSessionData).length) return results;

  const now = new Date();
  Object.keys(currentTagSessionData).forEach((cardUid) => {
    const cardData = currentTagSessionData[cardUid] as Session[];
    const latestSession = cardData[cardData.length - 1];
    if (!latestSession) return;

    if (isCramming || (latestSession.nextDueDate as Date) <= now) {
      results.push(cardUid);
    }
  });

  results.sort((a, b) => {
    const aCards = currentTagSessionData[a] as Session[];
    const aLatestSession = aCards[aCards.length - 1];
    const bCards = currentTagSessionData[b] as Session[];
    const bLatestSession = bCards[bCards.length - 1];

    const aNextDueDate = aLatestSession.nextDueDate || new Date(0);
    const bNextDueDate = bLatestSession.nextDueDate || new Date(0);

    return aNextDueDate < bNextDueDate ? 1 : -1;
  });

  return results;
};

export const addDueCards = ({ today, tagsList, sessionData, isCramming, shuffleCards }) => {
  for (const currentTag of tagsList) {
    const currentTagSessionData = sessionData[currentTag];
    const dueCardsUids = getDueCardUids(currentTagSessionData, isCramming);

    if (shuffleCards) {
      dueCardsUids.sort(() => Math.random() - 0.5);
    }

    today.tags[currentTag] = {
      ...today.tags[currentTag],
      dueUids: dueCardsUids,
      due: dueCardsUids.length,
    };
  }
};

export const restoreCompletedUids = ({ today, tagsList }) => {
  for (const currentTag of tagsList) {
    today.tags[currentTag].newUids.push(...today.tags[currentTag].completedNewUids);
    today.tags[currentTag].dueUids.push(...today.tags[currentTag].completedDueUids);
    today.tags[currentTag].new = today.tags[currentTag].newUids.length;
    today.tags[currentTag].due = today.tags[currentTag].dueUids.length;
  }
};

export const limitRemainingPracticeData = ({
  today,
  dailyLimit,
  tagsList,
  isCramming,
}: {
  today: Today;
  dailyLimit: number;
  tagsList: string[];
  isCramming: boolean;
}) => {
  const totalCards = today.combinedToday.due + today.combinedToday.new;

  if (!dailyLimit || !totalCards || isCramming) {
    return;
  }

  restoreCompletedUids({ today, tagsList });

  const selectedCards = tagsList.reduce(
    (acc, currentTag) => ({
      ...acc,
      [currentTag]: {
        newUids: [],
        dueUids: [],
      },
    }),
    {}
  );

  const targetNewCardsRatio = 0.25;
  const targetTotalCards = dailyLimit;
  const targetNewCards =
    targetTotalCards === 1 ? 0 : Math.max(1, Math.floor(targetTotalCards * targetNewCardsRatio));
  const targetDueCards = targetTotalCards - targetNewCards;

  let totalNewAdded = 0;
  let totalDueAdded = 0;
  let totalAdded = totalNewAdded + totalDueAdded;

  roundRobinLoop: while (totalAdded < totalCards) {
    for (const currentTag of tagsList) {
      totalAdded = totalNewAdded + totalDueAdded;

      if (totalAdded === targetTotalCards) {
        break roundRobinLoop;
      }

      const currentCards = selectedCards[currentTag];
      const nextNewIndex = currentCards.newUids.length;
      const nextNewCard = today.tags[currentTag].newUids[nextNewIndex];
      const nextDueIndex = currentCards.dueUids.length;
      const nextDueCard = today.tags[currentTag].dueUids[nextDueIndex];

      const stillNeedNewCards = totalNewAdded < targetNewCards;
      const stillNeedDueCards = totalDueAdded < targetDueCards;
      const stillHaveDueCards = !!nextDueCard || totalDueAdded < today.combinedToday.due;
      const stillHaveNewCards = !!nextNewCard || totalNewAdded < today.combinedToday.new;

      if (nextNewCard && (stillNeedNewCards || !stillHaveDueCards)) {
        selectedCards[currentTag].newUids.push(today.tags[currentTag].newUids[nextNewIndex]);
        totalNewAdded++;
        continue;
      }

      if (nextDueCard && (stillNeedDueCards || !stillHaveNewCards)) {
        selectedCards[currentTag].dueUids.push(today.tags[currentTag].dueUids[nextDueIndex]);
        totalDueAdded++;
        continue;
      }
    }
  }

  for (const tag of tagsList) {
    const tagStats = today.tags[tag];
    const completedDueUids = tagStats.completedDueUids;
    const completedNewUids = tagStats.completedNewUids;
    const remainingTargetDue = Math.max(
      selectedCards[tag].dueUids.length - completedDueUids.length,
      0
    );
    const remainingTargetNew = Math.max(
      selectedCards[tag].newUids.length - completedNewUids.length,
      0
    );

    selectedCards[tag].dueUids = selectedCards[tag].dueUids.slice(0, remainingTargetDue);
    selectedCards[tag].newUids = selectedCards[tag].newUids.slice(0, remainingTargetNew);
  }

  for (const tag of tagsList) {
    today.tags[tag] = {
      ...today.tags[tag],
      dueUids: selectedCards[tag].dueUids,
      newUids: selectedCards[tag].newUids,
      due: selectedCards[tag].dueUids.length,
      new: selectedCards[tag].newUids.length,
    };
  }
};
