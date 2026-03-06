import React from 'react';
import { generatePracticeData } from '~/shared/review';
import { CompletionStatus } from '~/models/practice';
import { ReviewModes, Session } from '~/models/session';
import { customFromNow, daysBetween } from '~/utils/date';
import { archiveCard, BlockInfo, BlockTreeNode, createClient, fetchBlockInfo, getCurrentCardData, loadReviewSession, ReviewSettings, savePracticeData } from '~/standalone/lib/memoRepository';
import { renderRoamText } from '~/standalone/lib/text';
import { RoamApiError } from '~/standalone/lib/roamApi';

const DEFAULT_SETTINGS: ReviewSettings = {
  graph: '',
  token: '',
  tagsListString: 'memo',
  dataPageTitle: 'roam/memo',
  dailyLimit: 0,
  shuffleCards: false,
  globalExclusionTags: 'memo/archived',
};

const STORAGE_KEY = 'roam-memo-standalone-settings';
const ARCHIVE_TAG = 'memo/archived';

const usePersistentSettings = () => {
  const [settings, setSettings] = React.useState<ReviewSettings>(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_SETTINGS;

    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    } catch (error) {
      return DEFAULT_SETTINGS;
    }
  });

  React.useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  return [settings, setSettings] as const;
};

const App = () => {
  const [settings, setSettings] = usePersistentSettings();
  const [sessionData, setSessionData] = React.useState<Awaited<ReturnType<typeof loadReviewSession>> | null>(null);
  const [selectedTag, setSelectedTag] = React.useState('');
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [showAnswers, setShowAnswers] = React.useState(false);
  const [reviewedUids, setReviewedUids] = React.useState<string[]>([]);
  const [blockCache, setBlockCache] = React.useState<Record<string, BlockInfo>>({});
  const [isLoading, setIsLoading] = React.useState(false);
  const [pendingWrites, setPendingWrites] = React.useState(0);
  const [syncWarning, setSyncWarning] = React.useState('');
  const [error, setError] = React.useState('');
  const [statusMessage, setStatusMessage] = React.useState('');
  const didAutoConnectRef = React.useRef(false);

  const client = React.useMemo(() => {
    if (!settings.graph.trim() || !settings.token.trim()) return null;
    return createClient({ graph: settings.graph, token: settings.token });
  }, [settings.graph, settings.token]);

  const refresh = React.useCallback(async () => {
    if (!client) {
      setError('Enter a graph and token to start.');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const nextSession = await loadReviewSession(client, settings);
      setSessionData(nextSession);
      setSelectedTag((current) => current || nextSession.tagsList[0] || '');
      setCurrentIndex(0);
      setReviewedUids([]);
      setBlockCache({});
      setSyncWarning('');
      setStatusMessage('');
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsLoading(false);
    }
  }, [client, settings]);

  const queuesByTag = React.useMemo(() => {
    if (!sessionData) return {};

    return Object.fromEntries(
      sessionData.tagsList.map((tag) => {
        const tagData = sessionData.today.tags[tag];
        const queue = [...tagData.dueUids, ...tagData.newUids].filter(
          (uid) => !reviewedUids.includes(uid)
        );
        return [tag, queue];
      })
    ) as Record<string, string[]>;
  }, [reviewedUids, sessionData]);

  const currentQueue = selectedTag ? queuesByTag[selectedTag] || [] : [];
  const currentRefUid = currentQueue[currentIndex];
  const currentSessions = currentRefUid && sessionData ? sessionData.practiceData[currentRefUid] || [] : [];
  const currentCardData = getCurrentCardData(currentSessions);
  const currentBlock = currentRefUid ? blockCache[currentRefUid] : undefined;
  const remainingCount = currentQueue.length;
  const totalCount = selectedTag && sessionData ? sessionData.today.tags[selectedTag]?.due + sessionData.today.tags[selectedTag]?.new : 0;

  const hasSavedCredentials = Boolean(settings.graph.trim() && settings.token.trim());

  React.useEffect(() => {
    if (!client || !hasSavedCredentials || didAutoConnectRef.current) return;

    didAutoConnectRef.current = true;
    void refresh();
  }, [client, hasSavedCredentials, refresh]);

  React.useEffect(() => {
    if (!sessionData) return;

    if (!selectedTag || !sessionData.tagsList.includes(selectedTag)) {
      setSelectedTag(sessionData.tagsList[0] || '');
    }
  }, [selectedTag, sessionData]);

  React.useEffect(() => {
    if (!client || !currentRefUid || blockCache[currentRefUid]) return;

    let cancelled = false;

    fetchBlockInfo(client, currentRefUid)
      .then((info) => {
        if (!cancelled) {
          setBlockCache((current) => ({ ...current, [currentRefUid]: info }));
        }
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(formatError(caughtError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [blockCache, client, currentRefUid]);

  React.useEffect(() => {
    if (!currentRefUid) {
      setShowAnswers(false);
      return;
    }

    const hasChildren = !!currentBlock?.childTree?.length;
    const hasInlineCloze = /\^\^.+?\^\^|\{.+?\}/.test(currentBlock?.string || '');
    setShowAnswers(!hasChildren && !hasInlineCloze);
  }, [currentBlock, currentRefUid]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!currentRefUid) return;

      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (!showAnswers && event.code === 'Space') {
        event.preventDefault();
        setShowAnswers(true);
        return;
      }

      if (showAnswers && currentCardData.reviewMode === ReviewModes.DefaultSpacedInterval) {
        if (event.key.toLowerCase() === 'f') void handleGrade(0);
        if (event.key.toLowerCase() === 'h') void handleGrade(2);
        if (event.key.toLowerCase() === 'g') void handleGrade(4);
        if (event.code === 'Space') {
          event.preventDefault();
          void handleGrade(5);
        }
      }

      if (event.key === 'ArrowRight') {
        setCurrentIndex((current) => Math.min(current + 1, Math.max(currentQueue.length - 1, 0)));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentCardData.reviewMode, currentQueue.length, currentRefUid, showAnswers]);

  const markCardReviewed = React.useCallback((uid: string, nextSession?: Session) => {
    setReviewedUids((current) => (current.includes(uid) ? current : [...current, uid]));

    setSessionData((current) => {
      if (!current) return current;

      const nextToday = {
        ...current.today,
        tags: { ...current.today.tags },
      };

      for (const tag of current.tagsList) {
        const tagData = current.today.tags[tag];
        const isDue = tagData.dueUids.includes(uid);
        const isNew = tagData.newUids.includes(uid);

        nextToday.tags[tag] = {
          ...tagData,
          dueUids: tagData.dueUids.filter((cardUid) => cardUid !== uid),
          newUids: tagData.newUids.filter((cardUid) => cardUid !== uid),
          due: isDue ? Math.max(tagData.due - 1, 0) : tagData.due,
          new: isNew ? Math.max(tagData.new - 1, 0) : tagData.new,
          completed: isDue || isNew ? tagData.completed + 1 : tagData.completed,
          completedUids:
            isDue || isNew
              ? Array.from(new Set([...tagData.completedUids, uid]))
              : tagData.completedUids,
          completedDue: isDue ? tagData.completedDue + 1 : tagData.completedDue,
          completedNew: isNew ? tagData.completedNew + 1 : tagData.completedNew,
          completedDueUids: isDue
            ? Array.from(new Set([...tagData.completedDueUids, uid]))
            : tagData.completedDueUids,
          completedNewUids: isNew
            ? Array.from(new Set([...tagData.completedNewUids, uid]))
            : tagData.completedNewUids,
        };
      }

      nextToday.combinedToday = {
        ...current.today.combinedToday,
        dueUids: current.today.combinedToday.dueUids.filter((cardUid) => cardUid !== uid),
        newUids: current.today.combinedToday.newUids.filter((cardUid) => cardUid !== uid),
        completedUids: Array.from(new Set([...current.today.combinedToday.completedUids, uid])),
      };
      nextToday.combinedToday.due = nextToday.combinedToday.dueUids.length;
      nextToday.combinedToday.new = nextToday.combinedToday.newUids.length;
      nextToday.combinedToday.completed = nextToday.combinedToday.completedUids.length;
      nextToday.combinedToday.status =
        nextToday.combinedToday.due + nextToday.combinedToday.new === 0
          ? CompletionStatus.Finished
          : CompletionStatus.Partial;

      return {
        ...current,
        today: nextToday,
        practiceData: {
          ...current.practiceData,
          [uid]:
            nextSession
              ? [...(current.practiceData[uid] || []), nextSession]
              : current.practiceData[uid],
        },
      };
    });
  }, []);

  const runOptimisticWrite = React.useCallback(
    ({
      refUid,
      optimisticSession,
      request,
      pendingLabel,
      successLabel,
    }: {
      refUid: string;
      optimisticSession?: Session;
      request: () => Promise<void>;
      pendingLabel: string;
      successLabel: string;
    }) => {
      setError('');
      setSyncWarning('');
      if (optimisticSession) {
        markCardReviewed(refUid, optimisticSession);
      } else {
        markCardReviewed(refUid);
      }

      setPendingWrites((current) => current + 1);
      setStatusMessage(pendingLabel);

      void request()
        .then(() => {
          setStatusMessage(successLabel);
        })
        .catch((caughtError) => {
          if (caughtError instanceof RoamApiError && caughtError.status === 429) {
            const retrySeconds = Math.ceil((caughtError.retryAfterMs || 0) / 1000);
            setSyncWarning(
              retrySeconds > 0
                ? `Roam rate-limited sync. The app backed off and retried automatically. If this persists, wait about ${retrySeconds}s before continuing.`
                : 'Roam rate-limited sync. The app retried automatically, but this item may need a manual reconnect.'
            );
          }
          setError(formatError(caughtError));
        })
        .finally(() => {
          setPendingWrites((current) => Math.max(current - 1, 0));
        });
    },
    [markCardReviewed]
  );

  const handleGrade = React.useCallback(
    (grade: number) => {
      if (!client || !currentRefUid) return;

      const referenceDate = new Date();
      const nextSession = {
        ...generatePracticeData({
          ...currentCardData,
          dateCreated: referenceDate,
          grade,
          reviewMode: currentCardData.reviewMode || ReviewModes.DefaultSpacedInterval,
        }),
        dateCreated: referenceDate,
      };

      runOptimisticWrite({
        refUid: currentRefUid,
        optimisticSession: nextSession,
        pendingLabel: `Syncing review for ${currentRefUid}...`,
        successLabel: `Saved review for ${currentRefUid}`,
        request: () =>
          savePracticeData(client, {
            ...nextSession,
            refUid: currentRefUid,
            dataPageTitle: settings.dataPageTitle,
          }),
      });
    },
    [client, currentCardData, currentRefUid, runOptimisticWrite, settings.dataPageTitle]
  );

  const handleFixedIntervalReview = React.useCallback(() => {
    if (!client || !currentRefUid) return;

    const referenceDate = new Date();
    const nextSession = {
      ...generatePracticeData({
        ...currentCardData,
        dateCreated: referenceDate,
        reviewMode: ReviewModes.FixedInterval,
      }),
      dateCreated: referenceDate,
    };

    runOptimisticWrite({
      refUid: currentRefUid,
      optimisticSession: nextSession,
      pendingLabel: `Syncing interval update for ${currentRefUid}...`,
      successLabel: `Saved interval update for ${currentRefUid}`,
      request: () =>
        savePracticeData(client, {
          ...nextSession,
          refUid: currentRefUid,
          dataPageTitle: settings.dataPageTitle,
        }),
    });
  }, [client, currentCardData, currentRefUid, runOptimisticWrite, settings.dataPageTitle]);

  const handleArchive = React.useCallback(() => {
    if (!client || !currentRefUid) return;

    runOptimisticWrite({
      refUid: currentRefUid,
      pendingLabel: `Archiving ${currentRefUid}...`,
      successLabel: `Archived ${currentRefUid}`,
      request: () =>
        archiveCard(client, {
          refUid: currentRefUid,
          dataPageTitle: settings.dataPageTitle,
          tag: ARCHIVE_TAG,
        }),
    });
  }, [client, currentRefUid, runOptimisticWrite, settings.dataPageTitle]);

  const intervalEstimates = React.useMemo(() => {
    if (currentCardData.reviewMode !== ReviewModes.DefaultSpacedInterval) return [];

    return [0, 2, 4, 5].map((grade) => ({
      grade,
      result: generatePracticeData({
        ...currentCardData,
        dateCreated: new Date(),
        grade,
        reviewMode: ReviewModes.DefaultSpacedInterval,
      }),
    }));
  }, [currentCardData]);

  const completionState =
    remainingCount === 0 ? CompletionStatus.Finished : CompletionStatus.Partial;

  return (
    <div className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy-wrap">
          <p className="eyebrow">Roam Backend Review</p>
          <h1>Memo review</h1>
          <p className="hero-copy">
            Fast review queue backed directly by the Roam API.
          </p>
        </div>
        <div className="summary-strip">
          <Stat label="Deck" value={selectedTag || 'None'} />
          <Stat label="Remaining" value={String(remainingCount)} />
          <Stat label="Status" value={completionState} />
          <Stat label="Sync" value={pendingWrites > 0 ? `${pendingWrites} pending` : 'Idle'} />
        </div>
      </section>

      <div className="layout-grid">
        <aside className="settings-panel">
          <section className="panel-card">
            <div className="panel-heading">
              <h2>Connection</h2>
              <button className="button secondary" onClick={refresh} disabled={isLoading || !client}>
                {isLoading ? 'Loading...' : 'Connect'}
              </button>
            </div>
            {sessionData?.peerOrigin ? (
              <p className="connection-meta">Connected to {sessionData.peerOrigin.replace('https://', '')}</p>
            ) : null}
            <label>
              Graph
              <input
                value={settings.graph}
                onChange={(event) => setSettings((current) => ({ ...current, graph: event.target.value }))}
                placeholder="tools"
              />
            </label>
            <label>
              Token
              <input
                value={settings.token}
                type="password"
                onChange={(event) => setSettings((current) => ({ ...current, token: event.target.value }))}
                placeholder="Roam graph token"
              />
            </label>
            <label>
              Tags
              <input
                value={settings.tagsListString}
                onChange={(event) => setSettings((current) => ({ ...current, tagsListString: event.target.value }))}
                placeholder="memo"
              />
            </label>
            <label>
              Data page
              <input
                value={settings.dataPageTitle}
                onChange={(event) => setSettings((current) => ({ ...current, dataPageTitle: event.target.value }))}
                placeholder="roam/memo"
              />
            </label>
            <label>
              Exclusion tags
              <input
                value={settings.globalExclusionTags}
                onChange={(event) => setSettings((current) => ({ ...current, globalExclusionTags: event.target.value }))}
                placeholder="memo/archived"
              />
            </label>
            <div className="field-row">
              <label>
                Daily limit
                <input
                  type="number"
                  min="0"
                  value={settings.dailyLimit}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      dailyLimit: Number(event.target.value || 0),
                    }))
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.shuffleCards}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      shuffleCards: event.target.checked,
                    }))
                  }
                />
                Shuffle cards
              </label>
            </div>
          </section>

          <section className="panel-card">
            <div className="panel-heading">
              <h2>Decks</h2>
            </div>
            <div className="deck-list">
              {(sessionData?.tagsList || []).map((tag) => {
                const tagStats = sessionData?.today.tags[tag];
                const queueSize = queuesByTag[tag]?.length || 0;

                return (
                  <button
                    key={tag}
                    className={tag === selectedTag ? 'deck-pill active' : 'deck-pill'}
                    onClick={() => {
                      setSelectedTag(tag);
                      setCurrentIndex(0);
                    }}
                  >
                    <span>{tag}</span>
                    <span>{queueSize}/{(tagStats?.due || 0) + (tagStats?.new || 0)}</span>
                  </button>
                );
              })}
            </div>
            <div className="deck-totals">
              <Stat label="Due" value={String(sessionData?.today.tags[selectedTag]?.due || 0)} />
              <Stat label="New" value={String(sessionData?.today.tags[selectedTag]?.new || 0)} />
              <Stat label="Done today" value={String(sessionData?.today.tags[selectedTag]?.completed || 0)} />
            </div>
          </section>
        </aside>

        <main className="review-panel">
          <section className="panel-card review-card">
            <div className="review-header">
              <div>
                <p className="eyebrow">Current card</p>
                <h2>{currentRefUid || 'No cards ready'}</h2>
              </div>
              <div className="status-cluster">
                {currentCardData?.nextDueDate ? (
                  <span className="status-badge">
                    {getDueLabel(currentCardData)}
                  </span>
                ) : (
                  <span className="status-badge">New</span>
                )}
                <span className="status-badge muted">
                  {currentRefUid ? `${Math.min(currentIndex + 1, remainingCount)} / ${Math.max(remainingCount, totalCount)}` : '0 / 0'}
                </span>
              </div>
            </div>

            {error ? <div className="banner error">{error}</div> : null}
            {syncWarning ? <div className="banner warning">{syncWarning}</div> : null}
            {statusMessage ? <div className="banner success">{statusMessage}</div> : null}

            {currentRefUid && currentBlock ? (
              <>
                <div className="breadcrumbs">
                  {currentBlock.breadcrumbs
                    .map((crumb) => crumb[':node/title'] || crumb[':block/string'])
                    .filter(Boolean)
                    .map((crumb, index) => (
                      <span key={`${crumb}-${index}`} className="crumb">
                        {crumb}
                      </span>
                    ))}
                </div>

                {currentBlock.parentBlocks.length ? (
                  <article className="context-block">
                    <p className="block-label">Parent context</p>
                    <div className="context-stack">
                      {currentBlock.parentBlocks.map((block, index) => (
                        <div key={`${block}-${index}`} className="context-line">
                          {renderRoamText(block, true)}
                        </div>
                      ))}
                    </div>
                  </article>
                ) : null}

                <article className="prompt-block">
                  <p className="block-label">Prompt</p>
                  <div className="block-text">{renderRoamText(currentBlock.string, showAnswers)}</div>
                </article>

                {currentBlock.childTree.length > 0 ? (
                  <article className="answer-block">
                    <div className="answer-header">
                      <p className="block-label">Children</p>
                      {!showAnswers ? (
                        <button className="button primary" onClick={() => setShowAnswers(true)}>
                          Show answer
                        </button>
                      ) : null}
                    </div>

                    {showAnswers ? (
                      <BlockTree tree={currentBlock.childTree} />
                    ) : (
                      <div className="answer-placeholder">Hidden until revealed.</div>
                    )}
                  </article>
                ) : null}

                <div className="action-row">
                  <button
                    className="button secondary"
                    onClick={() => setCurrentIndex((current) => Math.max(current - 1, 0))}
                    disabled={currentIndex === 0}
                  >
                    Previous
                  </button>
                  <button
                    className="button ghost"
                    onClick={() =>
                      setCurrentIndex((current) => Math.min(current + 1, Math.max(currentQueue.length - 1, 0)))
                    }
                    disabled={!currentRefUid}
                  >
                    Skip
                  </button>
                  <button className="button ghost danger" onClick={handleArchive}>
                    Archive
                  </button>
                </div>

                {showAnswers ? (
                  currentCardData.reviewMode === ReviewModes.FixedInterval ? (
                    <div className="grade-grid single">
                      <button className="grade-button grade-good" onClick={handleFixedIntervalReview}>
                        <span>Save interval</span>
                        <strong>{generatePracticeData({ ...currentCardData, dateCreated: new Date(), reviewMode: ReviewModes.FixedInterval }).nextDueDateFromNow}</strong>
                      </button>
                    </div>
                  ) : (
                    <div className="grade-grid">
                      {intervalEstimates.map(({ grade, result }) => (
                        <button
                          key={grade}
                          className={gradeButtonClassName(grade)}
                          onClick={() => void handleGrade(grade)}
                        >
                          <span>{gradeLabel(grade)}</span>
                          <strong>{result.nextDueDateFromNow}</strong>
                        </button>
                      ))}
                    </div>
                  )
                ) : null}
              </>
            ) : (
              <div className="empty-state">
                <h3>No cards ready.</h3>
                <p>Connect to the graph, pick a tag, or review a few new cards to seed the queue.</p>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="stat-card">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const BlockTree = ({ tree }: { tree: BlockTreeNode[] }) => (
  <ul className="answer-tree">
    {tree.map((node) => (
      <li key={node.uid}>
        <div className="answer-tree-line">{renderRoamText(node.string, true)}</div>
        {node.children.length ? <BlockTree tree={node.children} /> : null}
      </li>
    ))}
  </ul>
);

const formatError = (error: unknown) => {
  if (error instanceof RoamApiError) {
    if (error.status === 429) {
      return 'Roam API rate limit reached (50 requests/min/graph). Sync was delayed; try slowing the review pace briefly.';
    }

    return `${error.message} (${error.status})`;
  }

  if (error instanceof Error) return error.message;
  return 'Unexpected error';
};

const getDueLabel = (session: Session) => {
  if (!session.nextDueDate) return 'New';

  const dayDelta = daysBetween(session.nextDueDate, new Date());
  if (dayDelta === 0) return 'Due today';
  if (session.nextDueDate <= new Date()) return `Past due ${customFromNow(session.nextDueDate)}`;
  return `Next ${customFromNow(session.nextDueDate)}`;
};

const gradeLabel = (grade: number) => {
  switch (grade) {
    case 0:
      return 'Forgot';
    case 2:
      return 'Hard';
    case 4:
      return 'Good';
    case 5:
      return 'Perfect';
    default:
      return String(grade);
  }
};

const gradeButtonClassName = (grade: number) => {
  switch (grade) {
    case 0:
      return 'grade-button grade-forgot';
    case 2:
      return 'grade-button grade-hard';
    case 4:
      return 'grade-button grade-good';
    case 5:
      return 'grade-button grade-perfect';
    default:
      return 'grade-button';
  }
};

export default App;
