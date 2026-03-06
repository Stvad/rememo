import { CompleteRecords, ReviewModes, Session } from '~/models/session';
import { Today } from '~/models/practice';
import { addDueCards, addNewCards, calculateCombinedCounts, calculateCompletedTodayCounts, calculateTodayStatus, initializeToday, limitRemainingPracticeData } from '~/shared/planner';
import { getBlockChildren, getBlockOrder, getBlockString, getBlockUid, mapPluginPageData } from '~/shared/records';
import { dateToRoamDateString } from '~/shared/roamDates';
import { addDays } from '~/utils/date';
import { RoamApiClient } from '~/standalone/lib/roamApi';
import { generateUid } from '~/standalone/lib/uid';

export interface ReviewSettings {
  graph: string;
  token: string;
  tagsListString: string;
  dataPageTitle: string;
  dailyLimit: number;
  shuffleCards: boolean;
  globalExclusionTags: string;
}

export interface ReviewSessionData {
  practiceData: CompleteRecords;
  today: Today;
  tagsList: string[];
  peerOrigin: string;
}

export interface BlockTreeNode {
  uid: string;
  string: string;
  children: BlockTreeNode[];
}

export interface BlockInfo {
  string: string;
  childTree: BlockTreeNode[];
  breadcrumbs: Array<{ ':block/uid'?: string; ':node/title'?: string; ':block/string'?: string }>;
  parentBlocks: string[];
  refUid: string;
}

const getEmojiFromGrade = (grade?: number) => {
  switch (grade) {
    case 5:
      return '🟢';
    case 4:
      return '🔵';
    case 3:
      return '🟠';
    case 2:
      return '🟠';
    case 0:
      return '🔴';
    default:
      return '🟢';
  }
};

export const splitTagsList = (str: string) => {
  const result: string[] = [];
  let current = '';
  let isInsideQuote = false;

  for (let i = 0; i < str.length; i++) {
    const currentChar = str[i];
    if (currentChar === '"') {
      isInsideQuote = !isInsideQuote;
    } else if (currentChar === ',' && !isInsideQuote) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += currentChar;
    }
  }

  if (current.trim()) result.push(current.trim());

  return result;
};

const getPageQuery = `[
  :find ?uid
  :in $ ?title
  :where
    [?page :node/title ?title]
    [?page :block/uid ?uid]
]`;

const getBlockOnPageQuery = `[
  :find ?blockUid
  :in $ ?pageTitle ?blockString
  :where
    [?page :node/title ?pageTitle]
    [?block :block/parents ?page]
    [?block :block/string ?blockString]
    [?block :block/uid ?blockUid]
]`;

const exactChildBlockQuery = `[
  :find ?blockUid
  :in $ ?parentUid ?blockString
  :where
    [?parent :block/uid ?parentUid]
    [?block :block/parents ?parent]
    [?block :block/string ?blockString]
    [?block :block/uid ?blockUid]
]`;

const pluginPageBlockDataQuery = `[
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

const dataPageUidQuery = `[
  :find ?page
  :in $ ?pageTitle
  :where
    [?page :node/title ?pageTitle]
]`;

const dataPageReferencesIdsQuery = `[
  :find ?refUid
  :in $ ?tag ?dataPage
  :where
    [?tagPage :node/title ?tag]
    [?tagRefs :block/refs ?tagPage]
    [?tagRefs :block/uid ?refUid]
    [?tagRefs :block/page ?homePage]
    [(!= ?homePage ?dataPage)]
]`;

const childBlocksOnPageQuery = `[
  :find (pull ?tagPage [
    :block/uid
    :block/string
    :block/children
    {:block/children ...}])
  :in $ ?tag
  :where
    [?tagPage :node/title ?tag]
    [?tagPage :block/children ?tagPageChildren]
]`;

const cardUidsWithTagQuery = `[
  :find ?cardString
  :in $ ?pageTitle ?tag
  :where
    [?page :node/title ?pageTitle]
    [?page :block/children ?dataBlock]
    [?dataBlock :block/string "data"]
    [?dataBlock :block/children ?cardBlock]
    [?cardBlock :block/string ?cardString]
    [?cardBlock :block/children ?childBlock]
    [?tagPage :node/title ?tag]
    [?childBlock :block/refs ?tagPage]
]`;

const blockInfoQuery = `[
  :find (pull ?block [
    :block/string
    :block/uid
    :block/children
    {:block/children ...}])
  :in $ ?refId
  :where
    [?block :block/uid ?refId]
]`;

const parentChainInfoQuery = `[
  :find (pull ?parentIds [
    :node/title
    :block/string
    :block/uid])
  :in $ ?refId
  :where
    [?block :block/uid ?refId]
    [?block :block/parents ?parentIds]
]`;

const getPageUid = async (client: RoamApiClient, title: string) => {
  const result = await client.query<Array<[string]>>(getPageQuery, [title]);
  return result.length ? result[0][0] : '';
};

const getBlockOnPage = async (client: RoamApiClient, pageTitle: string, blockString: string) => {
  const result = await client.query<Array<[string]>>(getBlockOnPageQuery, [pageTitle, blockString]);
  return result.length ? result[0][0] : '';
};

const getChildBlock = async (client: RoamApiClient, parentUid: string, blockString: string) => {
  const result = await client.query<Array<[string]>>(exactChildBlockQuery, [parentUid, blockString]);
  return result.length ? result[0][0] : '';
};

const createPage = async (client: RoamApiClient, pageTitle: string) => {
  const uid = generateUid();
  await client.write({
    action: 'create-page',
    page: {
      title: pageTitle,
      uid,
    },
  });

  return uid;
};

const createChildBlock = async (
  client: RoamApiClient,
  parentUid: string,
  blockString: string,
  order: number,
  blockProps: Record<string, unknown> = {}
) => {
  const uid = generateUid();
  await client.write({
    action: 'create-block',
    location: {
      'parent-uid': parentUid,
      order,
    },
    block: {
      string: blockString,
      uid,
      ...blockProps,
    },
  });

  return uid;
};

const batchActionsWrite = async (
  client: RoamApiClient,
  actions: Array<Record<string, unknown>>
) => {
  if (!actions.length) return;

  await client.write({
    action: 'batch-actions',
    actions,
  });
};

const getOrCreatePage = async (client: RoamApiClient, pageTitle: string) => {
  const existingUid = await getPageUid(client, pageTitle);
  if (existingUid) return existingUid;
  return createPage(client, pageTitle);
};

const getOrCreateBlockOnPage = async (
  client: RoamApiClient,
  pageTitle: string,
  blockString: string,
  order: number,
  blockProps: Record<string, unknown> = {}
) => {
  const existingUid = await getBlockOnPage(client, pageTitle, blockString);
  if (existingUid) return existingUid;

  const pageUid = await getOrCreatePage(client, pageTitle);
  return createChildBlock(client, pageUid, blockString, order, blockProps);
};

const getOrCreateChildBlock = async (
  client: RoamApiClient,
  parentUid: string,
  blockString: string,
  order: number,
  blockProps: Record<string, unknown> = {}
) => {
  const existingUid = await getChildBlock(client, parentUid, blockString);
  if (existingUid) return existingUid;
  return createChildBlock(client, parentUid, blockString, order, blockProps);
};

const getPluginPageData = async (client: RoamApiClient, dataPageTitle: string) => {
  const queryResults = await client.query<any[][]>(pluginPageBlockDataQuery, [dataPageTitle, 'data']);
  if (!queryResults.length) return {};
  return mapPluginPageData(queryResults);
};

const getPageReferenceIds = async (client: RoamApiClient, tag: string, dataPageTitle: string) => {
  const dataPageResult = await client.query<Array<[string]>>(dataPageUidQuery, [dataPageTitle]);
  const dataPageUid = dataPageResult.length ? dataPageResult[0][0] : '';
  const results = await client.query<Array<[string]>>(dataPageReferencesIdsQuery, [tag, dataPageUid]);
  return results.map((arr) => arr[0]);
};

const getSelectedTagPageBlocksIds = async (client: RoamApiClient, selectedTag: string) => {
  const queryResults = await client.query<any[][]>(childBlocksOnPageQuery, [selectedTag]);
  if (!queryResults.length) return [];

  const children = getBlockChildren(queryResults[0][0]);
  return children.filter((child) => !!getBlockString(child)).map((child) => getBlockUid(child));
};

const getCardUidsWithTag = async (
  client: RoamApiClient,
  dataPageTitle: string,
  tag: string
) => {
  const uids = new Set<string>();
  const results = await client.query<Array<[string]>>(cardUidsWithTagQuery, [dataPageTitle, tag]);

  for (const [cardString] of results) {
    const match = cardString.match(/\(\((.+?)\)\)/);
    if (match) {
      uids.add(match[1]);
    }
  }

  return uids;
};

const getCardUidsWithAnyTag = async (
  client: RoamApiClient,
  dataPageTitle: string,
  tags: string[]
) => {
  const combined = new Set<string>();

  for (const tag of tags) {
    const tagUids = await getCardUidsWithTag(client, dataPageTitle, tag);
    for (const uid of tagUids) {
      combined.add(uid);
    }
  }

  return combined;
};

const getSessionData = async (
  client: RoamApiClient,
  pluginPageData: CompleteRecords,
  tag: string,
  dataPageTitle: string
) => {
  const tagReferencesIds = await getPageReferenceIds(client, tag, dataPageTitle);
  const tagPageBlocksIds = await getSelectedTagPageBlocksIds(client, tag);
  const allTagCardsUids = tagReferencesIds.concat(tagPageBlocksIds);

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

export const createClient = (settings: Pick<ReviewSettings, 'graph' | 'token'>) =>
  new RoamApiClient(settings.graph.trim(), settings.token.trim());

export const loadReviewSession = async (
  client: RoamApiClient,
  settings: ReviewSettings
): Promise<ReviewSessionData> => {
  const tagsList = splitTagsList(settings.tagsListString);
  const exclusionTags = splitTagsList(settings.globalExclusionTags);
  const practiceData = await getPluginPageData(client, settings.dataPageTitle);
  const excludedUids =
    exclusionTags.length > 0
      ? await getCardUidsWithAnyTag(client, settings.dataPageTitle, exclusionTags)
      : new Set<string>();

  const today = initializeToday({ tagsList, cachedData: {} });
  const sessionData = {};
  const cardUids: Record<string, string[]> = {};

  for (const tag of tagsList) {
    const current = await getSessionData(client, practiceData, tag, settings.dataPageTitle);
    const filteredSessionData = { ...current.sessionData };
    const filteredCardUids = current.cardUids.filter((uid) => !excludedUids.has(uid));

    for (const uid of Object.keys(filteredSessionData)) {
      if (excludedUids.has(uid)) {
        delete filteredSessionData[uid];
      }
    }

    sessionData[tag] = filteredSessionData;
    cardUids[tag] = filteredCardUids;
  }

  calculateCompletedTodayCounts({ today, tagsList, sessionData });
  addNewCards({
    today,
    tagsList,
    cardUids,
    pluginPageData: practiceData,
    shuffleCards: settings.shuffleCards,
  });
  addDueCards({
    today,
    tagsList,
    sessionData,
    isCramming: false,
    shuffleCards: settings.shuffleCards,
  });
  calculateCombinedCounts({ today, tagsList });
  limitRemainingPracticeData({
    today,
    dailyLimit: settings.dailyLimit,
    tagsList,
    isCramming: false,
  });
  calculateCombinedCounts({ today, tagsList });
  calculateTodayStatus({ today, tagsList });

  return {
    practiceData,
    today,
    tagsList,
    peerOrigin: await client.getPeerOrigin(),
  };
};

export const fetchBlockInfo = async (client: RoamApiClient, refUid: string): Promise<BlockInfo> => {
  const [blockRows, breadcrumbRows] = await Promise.all([
    client.query<any[][]>(blockInfoQuery, [refUid]),
    client.query<any[][]>(parentChainInfoQuery, [refUid]),
  ]);

  const blockInfo = blockRows[0]?.[0];
  const toTreeNode = (node): BlockTreeNode => ({
    uid: getBlockUid(node),
    string: getBlockString(node),
    children: getBlockChildren(node)
      .sort((a, b) => getBlockOrder(a) - getBlockOrder(b))
      .map(toTreeNode),
  });

  const childTree = getBlockChildren(blockInfo)
    .sort((a, b) => getBlockOrder(a) - getBlockOrder(b))
    .map(toTreeNode);
  const breadcrumbs = breadcrumbRows.map((row) => row[0]);
  const parentBlocks = breadcrumbs
    .map((crumb) => crumb[':block/string'])
    .filter(Boolean);

  return {
    string: getBlockString(blockInfo),
    childTree,
    breadcrumbs,
    parentBlocks,
    refUid,
  };
};

export const savePracticeData = async (
  client: RoamApiClient,
  { refUid, dataPageTitle, dateCreated, ...data }: Session & { refUid: string; dataPageTitle: string }
) => {
  let pageUid = await getPageUid(client, dataPageTitle);
  const actions: Array<Record<string, unknown>> = [];

  if (!pageUid) {
    pageUid = generateUid();
    actions.push({
      action: 'create-page',
      page: {
        title: dataPageTitle,
        uid: pageUid,
      },
    });
  }

  let dataBlockUid = await getBlockOnPage(client, dataPageTitle, 'data');
  if (!dataBlockUid) {
    dataBlockUid = generateUid();
    actions.push({
      action: 'create-block',
      location: {
        'parent-uid': pageUid,
        order: -1,
      },
      block: {
        uid: dataBlockUid,
        string: 'data',
        open: false,
        heading: 3,
      },
    });
  }

  let cardDataBlockUid = await getChildBlock(client, dataBlockUid, `((${refUid}))`);
  if (!cardDataBlockUid) {
    cardDataBlockUid = generateUid();
    actions.push({
      action: 'create-block',
      location: {
        'parent-uid': dataBlockUid,
        order: 0,
      },
      block: {
        uid: cardDataBlockUid,
        string: `((${refUid}))`,
        open: false,
      },
    });
  }

  const referenceDate = dateCreated || new Date();
  const dateCreatedRoamDateString = dateToRoamDateString(referenceDate);
  const newDataBlockId = generateUid();
  actions.push({
    action: 'create-block',
    location: {
      'parent-uid': cardDataBlockUid,
      order: 0,
    },
    block: {
      uid: newDataBlockId,
      string: `[[${dateCreatedRoamDateString}]] ${getEmojiFromGrade(data.grade)}`,
      open: false,
    },
  });

  const nextDueDate =
    data.nextDueDate || addDays(referenceDate, typeof data.interval === 'number' ? data.interval : 0);

  for (const key of Object.keys(data)) {
    let value = data[key];
    if (key === 'nextDueDate') {
      value = `[[${dateToRoamDateString(nextDueDate)}]]`;
    }

    actions.push({
      action: 'create-block',
      location: {
        'parent-uid': newDataBlockId,
        order: -1,
      },
      block: {
        uid: generateUid(),
        string: `${key}:: ${value}`,
        open: false,
      },
    });
  }

  await batchActionsWrite(client, actions);
};

export const archiveCard = async (
  client: RoamApiClient,
  { refUid, dataPageTitle, tag }: { refUid: string; dataPageTitle: string; tag: string }
) => {
  let pageUid = await getPageUid(client, dataPageTitle);
  const actions: Array<Record<string, unknown>> = [];

  if (!pageUid) {
    pageUid = generateUid();
    actions.push({
      action: 'create-page',
      page: {
        title: dataPageTitle,
        uid: pageUid,
      },
    });
  }

  let dataBlockUid = await getBlockOnPage(client, dataPageTitle, 'data');
  if (!dataBlockUid) {
    dataBlockUid = generateUid();
    actions.push({
      action: 'create-block',
      location: {
        'parent-uid': pageUid,
        order: -1,
      },
      block: {
        uid: dataBlockUid,
        string: 'data',
        open: false,
        heading: 3,
      },
    });
  }

  let cardDataBlockUid = await getChildBlock(client, dataBlockUid, `((${refUid}))`);
  if (!cardDataBlockUid) {
    cardDataBlockUid = generateUid();
    actions.push({
      action: 'create-block',
      location: {
        'parent-uid': dataBlockUid,
        order: 0,
      },
      block: {
        uid: cardDataBlockUid,
        string: `((${refUid}))`,
        open: false,
      },
    });
  }

  const tagString = `[[${tag}]]`;
  const existingTagBlock = await getChildBlock(client, cardDataBlockUid, tagString);

  if (!existingTagBlock) {
    actions.push({
      action: 'create-block',
      location: {
        'parent-uid': cardDataBlockUid,
        order: -1,
      },
      block: {
        uid: generateUid(),
        string: tagString,
        open: false,
      },
    });
  }

  await batchActionsWrite(client, actions);
};

export const getCurrentCardData = (sessions: Session[]) =>
  sessions.length ? sessions[sessions.length - 1] : ({ reviewMode: ReviewModes.DefaultSpacedInterval } as Session);
