import { CompleteRecords, RecordUid } from '~/models/session';
import {
  addDueCards,
  addNewCards,
  calculateCombinedCounts,
  calculateCompletedTodayCounts,
  calculateTodayStatus,
  initializeToday,
} from '~/queries/today';
import { limitRemainingPracticeData } from '~/shared/planner';
import { getChildBlocksOnPage } from './utils';
import { getCardUidsWithAnyTag, getBlockUidsWithAllContentTags } from './tags';
import { mapPluginPageCachedData, mapPluginPageData, mapPluginPageDataLatest } from '~/shared/records';

export interface SessionFilterConfig {
  includeTags: string[];
  excludeTags: string[];
}

export const getPracticeData = async ({
  tagsList,
  dataPageTitle,
  dailyLimit,
  isCramming,
  shuffleCards,
  cachedData,
  sessionFilter = { includeTags: [], excludeTags: [] },
}: {
  tagsList: string[];
  dataPageTitle: string;
  dailyLimit: number;
  isCramming: boolean;
  shuffleCards: boolean;
  cachedData: any;
  sessionFilter?: SessionFilterConfig;
}) => {
  const pluginPageData = (await getPluginPageData({
    dataPageTitle,
    limitToLatest: false,
  })) as CompleteRecords;

  // Build exclusion set from exclude tags (metadata tags on data block)
  const excludedUids =
    sessionFilter.excludeTags.length > 0
      ? await getCardUidsWithAnyTag({ dataPageTitle, tags: sessionFilter.excludeTags })
      : new Set<string>();

  // Build inclusion set from include tags — searches the card block and its
  // parent chain (like Roam backlinks), not the metadata block.
  const includedUids =
    sessionFilter.includeTags.length > 0
      ? await getBlockUidsWithAllContentTags(sessionFilter.includeTags)
      : null; // null means "no inclusion filter" (include all)

  const shouldExclude = (uid: string) => {
    if (excludedUids.has(uid)) return true;
    if (includedUids !== null && !includedUids.has(uid)) return true;
    return false;
  };

  const today = initializeToday({ tagsList, cachedData });
  const sessionData = {};
  const cardUids: Record<string, RecordUid[]> = {};

  for (const tag of tagsList) {
    const { sessionData: currentSessionData, cardUids: currentCardUids } = await getSessionData({
      pluginPageData,
      tag,
      dataPageTitle,
    });

    const hasFilter = excludedUids.size > 0 || includedUids !== null;
    if (hasFilter) {
      for (const uid of Object.keys(currentSessionData)) {
        if (shouldExclude(uid)) {
          delete currentSessionData[uid];
        }
      }
    }

    sessionData[tag] = currentSessionData;
    cardUids[tag] = hasFilter
      ? currentCardUids.filter((uid) => !shouldExclude(uid))
      : currentCardUids;
  }

  await calculateCompletedTodayCounts({
    today,
    tagsList,
    sessionData,
  });

  addNewCards({ today, tagsList, cardUids, pluginPageData, shuffleCards });
  addDueCards({
    today,
    tagsList,
    sessionData,
    isCramming,
    shuffleCards,
  });

  calculateCombinedCounts({ today, tagsList });

  limitRemainingPracticeData({ today, dailyLimit, tagsList, isCramming });

  // Calculate combined counts again to update counts after limit filtering
  calculateCombinedCounts({ today, tagsList });

  calculateTodayStatus({ today, tagsList });

  return {
    practiceData: pluginPageData,
    todayStats: today,
  };
};

export const getDataPageQuery = (dataPageTitle) => `[
  :find ?page
  :where
    [?page :node/title "${dataPageTitle}"]
]`;

export const dataPageReferencesIdsQuery = `[
  :find ?refUid
  :in $ ?tag ?dataPage
  :where
    [?tagPage :node/title ?tag]
    [?tagRefs :block/refs ?tagPage]
    [?tagRefs :block/uid ?refUid]
    [?tagRefs :block/page ?homePage]
    [(!= ?homePage ?dataPage)]
  ]`;
const getPageReferenceIds = async (tag, dataPageTitle): Promise<string[]> => {
  // First query the data page so that we can exclude those references from the results
  const dataPageResult = window.roamAlphaAPI.q(getDataPageQuery(dataPageTitle));

  const dataPageUid = dataPageResult.length ? dataPageResult[0][0] : '';

  const results = window.roamAlphaAPI.q(dataPageReferencesIdsQuery, tag, dataPageUid);

  return results.map((arr) => arr[0]);
};

export const getSelectedTagPageBlocksIds = async (selectedTag): Promise<string[]> => {
  const queryResults = await getChildBlocksOnPage(selectedTag);

  if (!queryResults.length) return [];

  const children = queryResults[0][0].children;
  const filteredChildren = children.filter((child) => !!child.string);

  return filteredChildren.map((arr) => arr.uid);
};

export const getPluginPageBlockDataQuery = `[
  :find (pull ?pluginPageChildren [
    :block/string
    :block/children
    :block/order
    {:block/children ...}])
    :in $ ?pageTitle ?dataBlockName
    :where
    [?page :node/title ?pageTitle]
    [?page :block/children ?pluginPageChildren]
    [?pluginPageChildren :block/string ?dataBlockName]
  ]`;

const getPluginPageBlockData = async ({ dataPageTitle, blockName }) => {
  return await window.roamAlphaAPI.q(getPluginPageBlockDataQuery, dataPageTitle, blockName);
};

export const getPluginPageData = async ({ dataPageTitle, limitToLatest = true }) => {
  const queryResultsData = await getPluginPageBlockData({ dataPageTitle, blockName: 'data' });

  if (!queryResultsData.length) return {};

  return limitToLatest
    ? mapPluginPageDataLatest(queryResultsData)
    : mapPluginPageData(queryResultsData);
};

export const getPluginPageCachedData = async ({ dataPageTitle }) => {
  const queryResultsData = await getPluginPageBlockData({ dataPageTitle, blockName: 'cache' });

  if (!queryResultsData.length) return {};

  return mapPluginPageCachedData(queryResultsData);
};

/**
 * Gets all the card referencing a tag, then finds all the practice session data for those cards
 */
export const getSessionData = async ({
  pluginPageData,
  tag,
  dataPageTitle,
}: {
  pluginPageData: CompleteRecords;
  tag: string;
  dataPageTitle: string;
}) => {
  // Get all the cards for the tag
  const tagReferencesIds = await getPageReferenceIds(tag, dataPageTitle);
  const tagPageBlocksIds = await getSelectedTagPageBlocksIds(tag);
  const allTagCardsUids = tagReferencesIds.concat(tagPageBlocksIds);

  // Filter out due cards that aren't references to the currently selected tag
  // @TODO: we could probably do this at getPluginPageData query for a
  // performance boost
  const selectedTagCardsData = Object.keys(pluginPageData).reduce((acc, cur) => {
    if (allTagCardsUids.indexOf(cur) > -1) {
      acc[cur] = pluginPageData[cur];
    }
    return acc;
  }, {});

  return {
    sessionData: selectedTagCardsData,
    cardUids: allTagCardsUids,
  };
};
