import { CompleteRecords, Records, ReviewModes } from '~/models/session';
import { getStringBetween, isNumeric, parseConfigString } from '~/utils/string';
import { parseRoamDateString } from '~/shared/roamDates';

export const getBlockString = (node) => node?.string || node?.[':block/string'] || '';

export const getBlockChildren = (node) => node?.children || node?.[':block/children'] || [];

export const getBlockOrder = (node) => node?.order ?? node?.[':block/order'] ?? 0;

export const getBlockUid = (node) => node?.uid || node?.[':block/uid'] || '';

const getRootChildren = (queryResultsData) => getBlockChildren(queryResultsData?.map((arr) => arr[0])[0]);

const ensureReviewModeField = (record) => {
  const children = getBlockChildren(record);
  const hasReviewModeField = children.some((child) => getBlockString(child).includes('reviewMode'));

  if (hasReviewModeField) return { ...record, children };

  return {
    ...record,
    children: [
      ...children,
      {
        order: children.length,
        string: `reviewMode:: ${ReviewModes.DefaultSpacedInterval}`,
      },
    ],
  };
};

const parseFieldValues = (object, node) => {
  for (const field of ensureReviewModeField(node).children) {
    const [key, value] = parseConfigString(getBlockString(field));

    if (!key) continue;

    if (key === 'nextDueDate') {
      object[key] = parseRoamDateString(getStringBetween(value, '[[', ']]'));
    } else if (value === 'true' || value === 'false') {
      object[key] = value === 'true';
    } else if (isNumeric(value)) {
      object[key] = Number(value);
    } else {
      object[key] = value;
    }
  }
};

export const isSessionChild = (child: { string: string; children?: any[] }) => {
  const children = getBlockChildren(child);
  if (!children || children.length === 0) return false;

  const dateString = getStringBetween(getBlockString(child), '[[', ']]');
  const parsed = parseRoamDateString(dateString);
  return parsed instanceof Date && !isNaN(parsed.getTime());
};

export const mapPluginPageDataLatest = (queryResultsData): Records =>
  getRootChildren(queryResultsData)?.reduce((acc, cur) => {
    const uid = getStringBetween(getBlockString(cur), '((', '))');
    acc[uid] = {};

    const children = getBlockChildren(cur);
    if (!children.length) return acc;

    const sessionChildren = children.filter(isSessionChild);
    const latestChild = sessionChildren.find((child) => getBlockOrder(child) === 0) || sessionChildren[0];

    if (!latestChild) return acc;

    acc[uid].dateCreated = parseRoamDateString(getStringBetween(getBlockString(latestChild), '[[', ']]'));

    if (!getBlockChildren(latestChild).length) return acc;

    parseFieldValues(acc[uid], latestChild);

    return acc;
  }, {}) || {};

export const mapPluginPageData = (queryResultsData): CompleteRecords =>
  getRootChildren(queryResultsData)?.reduce((acc, cur) => {
    const uid = getStringBetween(getBlockString(cur), '((', '))');
    acc[uid] = [];

    const children = getBlockChildren(cur);
    if (!children.length) return acc;

    for (const child of children) {
      if (!isSessionChild(child)) continue;

      const record = {
        refUid: uid,
        dateCreated: parseRoamDateString(getStringBetween(getBlockString(child), '[[', ']]')),
      };

      parseFieldValues(record, child);

      acc[uid].push(record);
    }

    return acc;
  }, {}) || {};

export const mapPluginPageCachedData = (queryResultsData) => {
  const data = getRootChildren(queryResultsData);
  if (!data || !data.length) return {};

  return (
    data.reduce((acc, cur) => {
      const tag = getStringBetween(getBlockString(cur), '[[', ']]');
      acc[tag] =
        getBlockChildren(cur)?.reduce((childAcc, child) => {
          if (!getBlockString(child)) return childAcc;

          const [key, value] = getBlockString(child).split('::').map((s: string) => s.trim());
          const date = parseRoamDateString(value);

          childAcc[key] = !isNaN(date.getTime()) ? date : value;
          return childAcc;
        }, {}) || {};

      return acc;
    }, {}) || {}
  );
};
