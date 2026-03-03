import {
  createChildBlock,
  getChildBlock,
  getOrCreateBlockOnPage,
  getOrCreateChildBlock,
  getOrCreatePage,
} from '~/queries/utils';

/**
 * Adds a tag to a card's data entry as a child block: roam/memo > data > ((refUid)) > [[tag]]
 * Idempotent — won't add duplicate tags.
 */
export const addTagToCard = async ({
  refUid,
  dataPageTitle,
  tag,
}: {
  refUid: string;
  dataPageTitle: string;
  tag: string;
}) => {
  await getOrCreatePage(dataPageTitle);
  const dataBlockUid = await getOrCreateBlockOnPage(dataPageTitle, 'data', -1, {
    open: false,
    heading: 3,
  });

  const cardDataBlockUid = await getOrCreateChildBlock(dataBlockUid, `((${refUid}))`, 0, {
    open: false,
  });

  const tagString = `[[${tag}]]`;
  const existingTagBlock = getChildBlock(cardDataBlockUid, tagString);

  if (!existingTagBlock) {
    await createChildBlock(cardDataBlockUid, tagString, -1);
  }
};

/**
 * Removes a tag from a card's data entry by deleting the [[tag]] child block.
 */
export const removeTagFromCard = async ({
  refUid,
  dataPageTitle,
  tag,
}: {
  refUid: string;
  dataPageTitle: string;
  tag: string;
}) => {
  const dataBlockUid = getChildBlock(
    await getOrCreateBlockOnPage(dataPageTitle, 'data', -1, { open: false, heading: 3 }),
    `((${refUid}))`,
  );

  if (!dataBlockUid) return;

  const tagString = `[[${tag}]]`;
  const tagBlockUid = getChildBlock(dataBlockUid, tagString);

  if (tagBlockUid) {
    await window.roamAlphaAPI.deleteBlock({ block: { uid: tagBlockUid } });
  }
};

/**
 * Datalog query to find all card UIDs that have a specific tag as a child block
 * in their data entry.
 */
export const cardUidsWithTagQuery = `[
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

/**
 * Returns a Set of card UIDs that have a specific tag in their data entry.
 */
export const getCardUidsWithTag = async ({
  dataPageTitle,
  tag,
}: {
  dataPageTitle: string;
  tag: string;
}): Promise<Set<string>> => {
  const uids = new Set<string>();

  try {
    const results = window.roamAlphaAPI.q(cardUidsWithTagQuery, dataPageTitle, tag);
    if (!results || !results.length) return uids;

    for (const [cardString] of results) {
      const match = cardString.match(/\(\((.+?)\)\)/);
      if (match) {
        uids.add(match[1]);
      }
    }
  } catch (e) {
    console.error(`Error fetching card UIDs with tag "${tag}"`, e);
  }

  return uids;
};

/**
 * Returns a Set of card UIDs that have ANY of the specified tags.
 */
export const getCardUidsWithAnyTag = async ({
  dataPageTitle,
  tags,
}: {
  dataPageTitle: string;
  tags: string[];
}): Promise<Set<string>> => {
  const combined = new Set<string>();

  for (const tag of tags) {
    const uids = await getCardUidsWithTag({ dataPageTitle, tag });
    for (const uid of uids) {
      combined.add(uid);
    }
  }

  return combined;
};

/**
 * Returns a Set of card UIDs that have ALL of the specified tags.
 */
export const getCardUidsWithAllTags = async ({
  dataPageTitle,
  tags,
}: {
  dataPageTitle: string;
  tags: string[];
}): Promise<Set<string>> => {
  if (tags.length === 0) return new Set<string>();

  const tagSets = await Promise.all(
    tags.map((tag) => getCardUidsWithTag({ dataPageTitle, tag }))
  );

  // Intersect all sets
  const [first, ...rest] = tagSets;
  const result = new Set<string>();
  for (const uid of first) {
    if (rest.every((set) => set.has(uid))) {
      result.add(uid);
    }
  }

  return result;
};

// --- Content tag queries ---
// These search the original card block and its parent chain,
// like Roam's backlink section. Used for include filters.

/**
 * Finds block UIDs that directly reference a given tag page.
 */
const blocksDirectlyReferencingTagQuery = `[
  :find ?blockUid
  :in $ ?tag
  :where
    [?tagPage :node/title ?tag]
    [?block :block/refs ?tagPage]
    [?block :block/uid ?blockUid]
]`;

/**
 * Finds block UIDs that are descendants of a block referencing a given tag page.
 * Combined with the direct query above, this gives Roam-backlink-style matching:
 * a block matches if it or any of its ancestors references the tag.
 */
const blocksDescendingFromTagQuery = `[
  :find ?blockUid
  :in $ ?tag
  :where
    [?tagPage :node/title ?tag]
    [?ancestor :block/refs ?tagPage]
    [?block :block/parents ?ancestor]
    [?block :block/uid ?blockUid]
]`;

/**
 * Returns a Set of block UIDs where the block itself or any of its ancestors
 * references the given tag page. This mimics Roam's backlink behavior.
 */
export const getBlockUidsWithContentTag = async (tag: string): Promise<Set<string>> => {
  const uids = new Set<string>();

  try {
    const directResults = window.roamAlphaAPI.q(blocksDirectlyReferencingTagQuery, tag);
    if (directResults?.length) {
      for (const [uid] of directResults) {
        uids.add(uid);
      }
    }

    const descendantResults = window.roamAlphaAPI.q(blocksDescendingFromTagQuery, tag);
    if (descendantResults?.length) {
      for (const [uid] of descendantResults) {
        uids.add(uid);
      }
    }
  } catch (e) {
    console.error(`Error fetching block UIDs with content tag "${tag}"`, e);
  }

  return uids;
};

/**
 * Returns a Set of block UIDs that match ALL of the specified content tags
 * (block or ancestors reference the tag page).
 */
export const getBlockUidsWithAllContentTags = async (
  tags: string[]
): Promise<Set<string>> => {
  if (tags.length === 0) return new Set<string>();

  const tagSets = await Promise.all(tags.map(getBlockUidsWithContentTag));

  // Intersect all sets
  const [first, ...rest] = tagSets;
  const result = new Set<string>();
  for (const uid of first) {
    if (rest.every((set) => set.has(uid))) {
      result.add(uid);
    }
  }

  return result;
};
