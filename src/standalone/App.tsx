import React from 'react';
import { generatePracticeData } from '~/shared/review';
import { CompletionStatus } from '~/models/practice';
import { ReviewModes, Session } from '~/models/session';
import { archiveCard, BlockInfo, BlockTreeNode, createClient, fetchBlockInfo, getCurrentCardData, loadReviewSession, migrateCardToParent, ReviewSettings, savePracticeData } from '~/standalone/lib/memoRepository';
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
const REVIEW_IN_ROAM_TAG = 'memo/to-review';
const SUPPORT_URL = 'https://buymeacoffee.com/vlad.sitalo';
const PRELOAD_AHEAD_COUNT = 3;
const SOFT_UNDO_DELAY_MS = 3000;
type ReviewSessionData = Awaited<ReturnType<typeof loadReviewSession>>;
type PendingActionStatus = 'scheduled' | 'committing';
type PendingAction = {
  id: number;
  refUid: string;
  nextSession?: Session;
  undoLabel: string;
  status: PendingActionStatus;
};
type SwipeState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

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

const applyOptimisticUpdate = (
  current: ReviewSessionData,
  { refUid, nextSession }: Pick<PendingAction, 'refUid' | 'nextSession'>
): ReviewSessionData => {
  const nextToday = {
    ...current.today,
    tags: { ...current.today.tags },
  };

  for (const tag of current.tagsList) {
    const tagData = current.today.tags[tag];
    const isDue = tagData.dueUids.includes(refUid);
    const isNew = tagData.newUids.includes(refUid);

    nextToday.tags[tag] = {
      ...tagData,
      dueUids: tagData.dueUids.filter((cardUid) => cardUid !== refUid),
      newUids: tagData.newUids.filter((cardUid) => cardUid !== refUid),
      due: isDue ? Math.max(tagData.due - 1, 0) : tagData.due,
      new: isNew ? Math.max(tagData.new - 1, 0) : tagData.new,
      completed: isDue || isNew ? tagData.completed + 1 : tagData.completed,
      completedUids:
        isDue || isNew
          ? Array.from(new Set([...tagData.completedUids, refUid]))
          : tagData.completedUids,
      completedDue: isDue ? tagData.completedDue + 1 : tagData.completedDue,
      completedNew: isNew ? tagData.completedNew + 1 : tagData.completedNew,
      completedDueUids: isDue
        ? Array.from(new Set([...tagData.completedDueUids, refUid]))
        : tagData.completedDueUids,
      completedNewUids: isNew
        ? Array.from(new Set([...tagData.completedNewUids, refUid]))
        : tagData.completedNewUids,
    };
  }

  nextToday.combinedToday = {
    ...current.today.combinedToday,
    dueUids: current.today.combinedToday.dueUids.filter((cardUid) => cardUid !== refUid),
    newUids: current.today.combinedToday.newUids.filter((cardUid) => cardUid !== refUid),
    completedUids: Array.from(new Set([...current.today.combinedToday.completedUids, refUid])),
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
      [refUid]:
        nextSession
          ? [...(current.practiceData[refUid] || []), nextSession]
          : current.practiceData[refUid],
    },
  };
};

const App = () => {
  const [settings, setSettings] = usePersistentSettings();
  const [sessionData, setSessionData] = React.useState<ReviewSessionData | null>(null);
  const [selectedTag, setSelectedTag] = React.useState('');
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [showAnswers, setShowAnswers] = React.useState(false);
  const [showSetup, setShowSetup] = React.useState(false);
  const [pendingActions, setPendingActions] = React.useState<PendingAction[]>([]);
  const [blockCache, setBlockCache] = React.useState<Record<string, BlockInfo>>({});
  const [isLoading, setIsLoading] = React.useState(false);
  const [pendingWrites, setPendingWrites] = React.useState(0);
  const [syncWarning, setSyncWarning] = React.useState('');
  const [error, setError] = React.useState('');
  const [isMigratingCard, setIsMigratingCard] = React.useState(false);
  const didAutoConnectRef = React.useRef(false);
  const pendingActionIdRef = React.useRef(0);
  const swipeStateRef = React.useRef<SwipeState | null>(null);
  const blockFetchScopeRef = React.useRef(0);
  const pendingBlockFetchesRef = React.useRef<Record<string, Promise<void>>>({});
  const pendingActionTimersRef = React.useRef<Record<number, number>>({});
  const pendingActionRequestsRef = React.useRef<Record<number, () => Promise<void>>>({});

  const client = React.useMemo(() => {
    if (!settings.graph.trim() || !settings.token.trim()) return null;
    return createClient({ graph: settings.graph, token: settings.token });
  }, [settings.graph, settings.token]);

  const refresh = React.useCallback(async (options?: {
    selectedTag?: string;
    preferredRefUid?: string;
    fallbackIndex?: number;
    keepSetupOpen?: boolean;
  }) => {
    if (!client) {
      setError('Enter a graph and token to start.');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const nextSession = await loadReviewSession(client, settings);
      blockFetchScopeRef.current += 1;
      pendingBlockFetchesRef.current = {};
      const nextSelectedTag =
        options?.selectedTag && nextSession.tagsList.includes(options.selectedTag)
          ? options.selectedTag
          : selectedTag && nextSession.tagsList.includes(selectedTag)
            ? selectedTag
            : nextSession.tagsList[0] || '';
      const nextQueue = nextSelectedTag
        ? [
            ...(nextSession.today.tags[nextSelectedTag]?.dueUids || []),
            ...(nextSession.today.tags[nextSelectedTag]?.newUids || []),
          ]
        : [];
      const preferredIndex =
        options?.preferredRefUid ? nextQueue.indexOf(options.preferredRefUid) : -1;
      const fallbackIndex = Math.min(
        options?.fallbackIndex ?? 0,
        Math.max(nextQueue.length - 1, 0)
      );

      setSessionData(nextSession);
      setSelectedTag(nextSelectedTag);
      setCurrentIndex(preferredIndex >= 0 ? preferredIndex : fallbackIndex);
      setBlockCache({});
      setSyncWarning('');
      setShowSetup(options?.keepSetupOpen ?? false);
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsLoading(false);
    }
  }, [client, selectedTag, settings]);

  const displaySessionData = React.useMemo(() => {
    if (!sessionData) return null;

    return pendingActions.reduce(
      (current, update) => applyOptimisticUpdate(current, update),
      sessionData
    );
  }, [pendingActions, sessionData]);

  const queuesByTag = React.useMemo(() => {
    if (!displaySessionData) return {};

    return Object.fromEntries(
      displaySessionData.tagsList.map((tag) => {
        const tagData = displaySessionData.today.tags[tag];
        const queue = [...tagData.dueUids, ...tagData.newUids];
        return [tag, queue];
      })
    ) as Record<string, string[]>;
  }, [displaySessionData]);

  const currentQueue = React.useMemo(
    () => (selectedTag ? queuesByTag[selectedTag] || [] : []),
    [queuesByTag, selectedTag]
  );
  const currentRefUid = currentQueue[currentIndex];
  const currentSessions = currentRefUid && displaySessionData ? displaySessionData.practiceData[currentRefUid] || [] : [];
  const currentCardData = getCurrentCardData(currentSessions);
  const currentBlock = currentRefUid ? blockCache[currentRefUid] : undefined;
  const currentContextLines = currentBlock ? getContextLines(currentBlock) : [];
  const remainingCount = currentQueue.length;
  const totalCount = selectedTag && displaySessionData
    ? (displaySessionData.today.tags[selectedTag]?.due || 0) + (displaySessionData.today.tags[selectedTag]?.new || 0)
    : 0;
  const completedCount = selectedTag && displaySessionData ? displaySessionData.today.tags[selectedTag]?.completed || 0 : 0;
  const isReviewFinished = Boolean(displaySessionData && !currentRefUid && totalCount === 0 && completedCount > 0);
  const hasLoadedSession = Boolean(sessionData);

  const hasSavedCredentials = Boolean(settings.graph.trim() && settings.token.trim());
  const hasUnsavedWork = pendingActions.some((action) => action.status === 'scheduled') || pendingWrites > 0;
  const latestUndoableAction = React.useMemo(
    () => [...pendingActions].reverse().find((action) => action.status === 'scheduled') || null,
    [pendingActions]
  );

  React.useEffect(() => {
    if (!client || !hasSavedCredentials || didAutoConnectRef.current) return;

    didAutoConnectRef.current = true;
    void refresh();
  }, [client, hasSavedCredentials, refresh]);

  React.useEffect(() => {
    if (!displaySessionData) return;

    if (!selectedTag || !displaySessionData.tagsList.includes(selectedTag)) {
      setSelectedTag(displaySessionData.tagsList[0] || '');
    }
  }, [displaySessionData, selectedTag]);

  React.useEffect(() => {
    const nextMaxIndex = Math.max(currentQueue.length - 1, 0);
    if (currentIndex > nextMaxIndex) {
      setCurrentIndex(nextMaxIndex);
    }
  }, [currentIndex, currentQueue.length]);

  React.useEffect(() => {
    if (!hasUnsavedWork) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedWork]);

  const preloadBlock = React.useCallback(
    (refUid: string, { surfaceErrors = false }: { surfaceErrors?: boolean } = {}) => {
      if (!client || !refUid || blockCache[refUid]) return;

      const existingFetch = pendingBlockFetchesRef.current[refUid];
      if (existingFetch) return existingFetch;

      const fetchScope = blockFetchScopeRef.current;
      const request = fetchBlockInfo(client, refUid)
        .then((info) => {
          if (blockFetchScopeRef.current !== fetchScope) return;

          setBlockCache((current) => {
            if (current[refUid]) return current;
            return { ...current, [refUid]: info };
          });
        })
        .catch((caughtError) => {
          if (blockFetchScopeRef.current === fetchScope && surfaceErrors) {
            setError(formatError(caughtError));
          }
        })
        .finally(() => {
          delete pendingBlockFetchesRef.current[refUid];
        });

      pendingBlockFetchesRef.current[refUid] = request;
      return request;
    },
    [blockCache, client]
  );

  React.useEffect(() => {
    if (!client || !currentQueue.length) return;

    const upcomingUids = currentQueue.slice(currentIndex, currentIndex + PRELOAD_AHEAD_COUNT + 1);
    upcomingUids.forEach((refUid, index) => {
      void preloadBlock(refUid, { surfaceErrors: index === 0 });
    });
  }, [client, currentIndex, currentQueue, preloadBlock]);

  React.useEffect(() => {
    if (!currentRefUid) {
      setShowAnswers(false);
      return;
    }

    const hasChildren = !!currentBlock?.childTree?.length;
    const hasInlineCloze = /\^\^.+?\^\^|\{.+?\}/.test(currentBlock?.string || '');
    setShowAnswers(!hasChildren && !hasInlineCloze);
  }, [currentBlock, currentRefUid]);

  React.useEffect(() => () => {
    Object.values(pendingActionTimersRef.current).forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    pendingActionTimersRef.current = {};
    pendingActionRequestsRef.current = {};
  }, []);

  const commitPendingAction = React.useCallback(
    (pendingAction: PendingAction) => {
      delete pendingActionTimersRef.current[pendingAction.id];

      setPendingActions((current) =>
        current.map((action) =>
          action.id === pendingAction.id ? { ...action, status: 'committing' } : action
        )
      );

      const request = pendingActionRequestsRef.current[pendingAction.id];
      if (!request) return;

      setPendingWrites((current) => current + 1);

      void request()
        .then(() => {
          setSessionData((current) =>
            current ? applyOptimisticUpdate(current, pendingAction) : current
          );
          setPendingActions((current) =>
            current.filter((action) => action.id !== pendingAction.id)
          );
        })
        .catch((caughtError) => {
          setPendingActions((current) =>
            current.filter((action) => action.id !== pendingAction.id)
          );
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
          delete pendingActionRequestsRef.current[pendingAction.id];
          setPendingWrites((current) => Math.max(current - 1, 0));
        });
    },
    []
  );

  const scheduleOptimisticWrite = React.useCallback(
    ({
      refUid,
      optimisticSession,
      undoLabel,
      request,
    }: {
      refUid: string;
      optimisticSession?: Session;
      undoLabel: string;
      request: () => Promise<void>;
    }) => {
      const pendingAction = {
        id: pendingActionIdRef.current + 1,
        refUid,
        nextSession: optimisticSession,
        undoLabel,
        status: 'scheduled' as const,
      };

      pendingActionIdRef.current = pendingAction.id;
      setError('');
      setSyncWarning('');
      pendingActionRequestsRef.current[pendingAction.id] = request;
      pendingActionTimersRef.current[pendingAction.id] = window.setTimeout(() => {
        commitPendingAction(pendingAction);
      }, SOFT_UNDO_DELAY_MS);
      setPendingActions((current) => [...current, pendingAction]);
    },
    [commitPendingAction]
  );

  const handleUndoPendingAction = React.useCallback((pendingActionId: number) => {
    const timerId = pendingActionTimersRef.current[pendingActionId];
    if (timerId) {
      window.clearTimeout(timerId);
    }

    delete pendingActionTimersRef.current[pendingActionId];
    delete pendingActionRequestsRef.current[pendingActionId];
    setPendingActions((current) => current.filter((action) => action.id !== pendingActionId));
  }, []);

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

      scheduleOptimisticWrite({
        refUid: currentRefUid,
        optimisticSession: nextSession,
        undoLabel: 'Undo last review',
        request: () =>
          savePracticeData(client, {
            ...nextSession,
            refUid: currentRefUid,
            dataPageTitle: settings.dataPageTitle,
          }),
      });
    },
    [client, currentCardData, currentRefUid, scheduleOptimisticWrite, settings.dataPageTitle]
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

    scheduleOptimisticWrite({
      refUid: currentRefUid,
      optimisticSession: nextSession,
      undoLabel: 'Undo last review',
      request: () =>
        savePracticeData(client, {
          ...nextSession,
          refUid: currentRefUid,
          dataPageTitle: settings.dataPageTitle,
        }),
    });
  }, [client, currentCardData, currentRefUid, scheduleOptimisticWrite, settings.dataPageTitle]);

  const handleArchive = React.useCallback(() => {
    if (!client || !currentRefUid) return;

    scheduleOptimisticWrite({
      refUid: currentRefUid,
      undoLabel: 'Undo archive',
      request: () =>
        archiveCard(client, {
          refUid: currentRefUid,
          dataPageTitle: settings.dataPageTitle,
          tag: ARCHIVE_TAG,
        }),
    });
  }, [client, currentRefUid, scheduleOptimisticWrite, settings.dataPageTitle]);

  const handleReviewInRoam = React.useCallback(() => {
    if (!client || !currentRefUid) return;

    scheduleOptimisticWrite({
      refUid: currentRefUid,
      undoLabel: 'Undo review in Roam',
      request: () =>
        archiveCard(client, {
          refUid: currentRefUid,
          dataPageTitle: settings.dataPageTitle,
          tag: REVIEW_IN_ROAM_TAG,
        }),
    });
  }, [client, currentRefUid, scheduleOptimisticWrite, settings.dataPageTitle]);

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
  }, [currentCardData.reviewMode, currentQueue.length, currentRefUid, handleGrade, showAnswers]);

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

  const handleTouchStart = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (showSetup || !currentRefUid) return;

    const touch = event.touches[0];
    if (!touch) return;

    swipeStateRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
    };
  }, [currentRefUid, showSetup]);

  const handleTouchMove = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!swipeStateRef.current) return;

    const touch = event.touches[0];
    if (!touch) return;

    swipeStateRef.current = {
      ...swipeStateRef.current,
      currentX: touch.clientX,
      currentY: touch.clientY,
    };
  }, []);

  const handleTouchEnd = React.useCallback(() => {
    const swipeState = swipeStateRef.current;
    swipeStateRef.current = null;

    if (!swipeState || showSetup || !currentRefUid) return;

    const deltaX = swipeState.currentX - swipeState.startX;
    const deltaY = swipeState.currentY - swipeState.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (absX < 72 || absX < absY * 1.25) return;

    if (deltaX > 0) {
      if (!showAnswers && currentBlock) {
        setShowAnswers(true);
      } else if (showAnswers) {
        if (currentCardData.reviewMode === ReviewModes.FixedInterval) {
          void handleFixedIntervalReview();
        } else {
          void handleGrade(4);
        }
      }
      return;
    }

    void handleReviewInRoam();
  }, [
    currentBlock,
    currentCardData.reviewMode,
    currentRefUid,
    handleFixedIntervalReview,
    handleGrade,
    handleReviewInRoam,
    showAnswers,
    showSetup,
  ]);

  const handleTouchCancel = React.useCallback(() => {
    swipeStateRef.current = null;
  }, []);

  const handleMigrateCurrentCard = React.useCallback(async () => {
    if (!client || !currentRefUid || !currentBlock || !selectedTag) return;

    setIsMigratingCard(true);
    setError('');
    setSyncWarning('');

    try {
      const result = await migrateCardToParent(client, {
        blockInfo: currentBlock,
        dataPageTitle: settings.dataPageTitle,
        selectedTag,
      });

      if (result.skippedReason) {
        setError(result.skippedReason);
        return;
      }

      if (result.missingMetadata) {
        setSyncWarning(
          'Moved the deck tag to the parent block, but this card had no roam/memo history to repoint.'
        );
      }

      await refresh({
        selectedTag,
        preferredRefUid: result.parentUid,
        fallbackIndex: currentIndex,
      });
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsMigratingCard(false);
    }
  }, [client, currentBlock, currentIndex, currentRefUid, refresh, selectedTag, settings.dataPageTitle]);

  const setupPanel = (
    <section className="panel-card setup-card">
      <div className="setup-intro">
        <h1>Rememo</h1>
        <p className="setup-copy">
          Review your RoamResearch roam/memo cards.
        </p>
      </div>
      <ConnectionForm
        isLoading={isLoading}
        clientReady={Boolean(client)}
        onConnect={refresh}
        settings={settings}
        setSettings={setSettings}
      />
      <div className="support-card">
        <p>
          Rememo is free to use. If it helped you - you can say thank you and support its development
        </p>
        <a className="button secondary support-link" href={SUPPORT_URL} target="_blank" rel="noreferrer">
          <BuyMeACoffeeIcon />
          <span>Buy me a coffee</span>
        </a>
      </div>
    </section>
  );

  return (
    <div className={hasLoadedSession ? 'page-shell review-shell' : 'page-shell setup-shell'}>
      {hasLoadedSession ? (
        <main className="review-panel review-panel-full">
          <section className="panel-card review-card review-card-full">
            <div className="review-header">
              <div className="review-meta-row" role="tablist" aria-label="Decks and review status">
                {(displaySessionData?.tagsList || []).map((tag) => {
                  const tagStats = displaySessionData?.today.tags[tag];
                  const queueSize = queuesByTag[tag]?.length || 0;

                  return (
                    <button
                      key={tag}
                      className={tag === selectedTag ? 'deck-pill compact active' : 'deck-pill compact'}
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
                <span className="status-badge muted">
                  {currentRefUid ? `${Math.min(currentIndex + 1, remainingCount)} / ${Math.max(remainingCount, totalCount)}` : '0 / 0'}
                </span>
                {currentRefUid ? (
                  <span className="status-badge">{getCompactDueLabel(currentCardData)}</span>
                ) : isReviewFinished ? (
                  <span className="status-badge">Finished</span>
                ) : (
                  <span className="status-badge muted">Waiting</span>
                )}
                {pendingWrites > 0 ? (
                  <span className="status-badge muted">{pendingWrites} sync</span>
                ) : null}
              </div>
              <button
                className={showSetup ? 'icon-button active' : 'icon-button'}
                onClick={() => setShowSetup((current) => !current)}
                aria-label={showSetup ? 'Close setup' : 'Open setup'}
                title={showSetup ? 'Close setup' : 'Open setup'}
              >
                <SetupIcon />
              </button>
            </div>

            <div
              className="review-scroll-area"
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchCancel}
            >
              {error ? <div className="banner error">{error}</div> : null}
              {syncWarning ? <div className="banner warning">{syncWarning}</div> : null}

              {showSetup ? (
                <div className="review-setup-screen">{setupPanel}</div>
              ) : currentRefUid && currentBlock ? (
                <>
                {currentContextLines.length ? (
                  <article className="context-block">
                    <div className="context-stack">
                      {currentContextLines.map((block, index) => (
                        <div key={`${block}-${index}`} className="context-line">
                          {renderRoamText(block, true)}
                        </div>
                      ))}
                    </div>
                  </article>
                ) : null}

                <article className="prompt-block">
                  <div className="block-text">{renderRoamText(currentBlock.string, showAnswers)}</div>
                </article>

                {currentBlock.childTree.length > 0 && showAnswers ? (
                  <article className="answer-block">
                    <BlockTree tree={currentBlock.childTree} />
                  </article>
                ) : null}
                </>
              ) : currentRefUid ? (
                <div className="empty-state review-loading-state">
                  <h3>Loading card...</h3>
                  <p>Fetching prompt and context from Roam.</p>
                </div>
              ) : (
                <div className="empty-state">
                  <h3>{isReviewFinished ? 'Deck complete.' : hasLoadedSession ? 'No cards ready.' : 'Nothing loaded yet.'}</h3>
                  <p>
                    {isReviewFinished
                      ? `You finished ${completedCount} ${completedCount === 1 ? 'card' : 'cards'} in ${selectedTag || 'this deck'}.`
                      : hasLoadedSession
                        ? 'Connect to the graph, pick a tag, or review a few new cards to seed the queue.'
                        : 'Connect to the graph to load a review queue.'}
                  </p>
                  {isReviewFinished ? (
                    <a className="button secondary support-link finished-support-link" href={SUPPORT_URL} target="_blank" rel="noreferrer">
                      <BuyMeACoffeeIcon />
                      <span>Support Rememo</span>
                    </a>
                  ) : null}
                </div>
              )}
            </div>

            {latestUndoableAction && !showSetup ? (
              <div className="undo-toast" role="status" aria-live="polite">
                <span>Undo available for 3s.</span>
                <button
                  className="button secondary undo-button"
                  onClick={() => handleUndoPendingAction(latestUndoableAction.id)}
                >
                  {latestUndoableAction.undoLabel}
                </button>
              </div>
            ) : null}

            {currentRefUid && !showSetup ? (
              <div className="review-footer">
                <div className={currentBlock && !showAnswers ? 'action-row compact-actions reveal-actions' : 'action-row compact-actions compact-four-actions'}>
                  <button
                    className="button ghost"
                    onClick={() =>
                      setCurrentIndex((current) => Math.min(current + 1, Math.max(currentQueue.length - 1, 0)))
                    }
                    disabled={!currentRefUid}
                  >
                    Skip
                  </button>
                  <button
                    className="button ghost icon-action-button"
                    onClick={() => void handleMigrateCurrentCard()}
                    aria-label="Move card to parent"
                    title="Move card to parent"
                    disabled={isMigratingCard}
                  >
                    <ParentMigrationIcon />
                  </button>
                  <button
                    className="button ghost icon-action-button"
                    onClick={handleReviewInRoam}
                    aria-label="Review in Roam"
                    title="Review in Roam"
                  >
                    <RoamReviewIcon />
                  </button>
                  <button
                    className="button ghost danger icon-action-button"
                    onClick={handleArchive}
                    aria-label="Archive"
                    title="Archive"
                  >
                    <ArchiveIcon />
                  </button>
                  {currentBlock && !showAnswers ? (
                    <button className="button primary" onClick={() => setShowAnswers(true)}>
                      Reveal
                    </button>
                  ) : null}
                </div>

                {currentBlock && showAnswers ? (
                  currentCardData.reviewMode === ReviewModes.FixedInterval ? (
                    <div className="grade-grid single">
                      <button className="grade-button grade-good" onClick={handleFixedIntervalReview}>
                        <span>Save interval</span>
                        <strong>{getCompactNextReviewLabel(generatePracticeData({ ...currentCardData, dateCreated: new Date(), reviewMode: ReviewModes.FixedInterval }))}</strong>
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
                          <strong>{getCompactNextReviewLabel(result)}</strong>
                        </button>
                      ))}
                    </div>
                  )
                ) : null}
              </div>
            ) : null}
          </section>
        </main>
      ) : (
        <main className="setup-shell-main">
          {setupPanel}
        </main>
      )}
    </div>
  );
};

const ConnectionForm = ({
  isLoading,
  clientReady,
  onConnect,
  settings,
  setSettings,
}: {
  isLoading: boolean;
  clientReady: boolean;
  onConnect: () => void;
  settings: ReviewSettings;
  setSettings: React.Dispatch<React.SetStateAction<ReviewSettings>>;
}) => (
  <>
    <div className="panel-heading">
      <h2>Connection</h2>
      <button className="button secondary" onClick={onConnect} disabled={isLoading || !clientReady}>
        {isLoading ? 'Loading...' : 'Connect'}
      </button>
    </div>
    <label>
      Graph
      <input
        value={settings.graph}
        onChange={(event) => setSettings((current) => ({ ...current, graph: event.target.value }))}
        placeholder="your-graph-name"
      />
    </label>
    <label>
      <span className="field-label">
        Token
        <details className="field-help">
          <summary>How to get one</summary>
          <span>
            In Roam, open the graph menu, go to <strong>Settings</strong>, then <strong>Graph</strong>, and create a backend API token.
          </span>
        </details>
      </span>
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
  </>
);

const SetupIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.13 7.13 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
      fill="currentColor"
    />
  </svg>
);

const ArchiveIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M20.54 5.23 19.15 3.5a1 1 0 0 0-.78-.37H5.63a1 1 0 0 0-.78.37L3.46 5.23A2 2 0 0 0 3 6.5V8a1 1 0 0 0 1 1h1v8.5A2.5 2.5 0 0 0 7.5 20h9A2.5 2.5 0 0 0 19 17.5V9h1a1 1 0 0 0 1-1V6.5a2 2 0 0 0-.46-1.27ZM6.11 5h11.78l.8 1H5.31l.8-1ZM17 17.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V9h10v8.5ZM10 11h4a1 1 0 1 1 0 2h-4a1 1 0 1 1 0-2Z"
      fill="currentColor"
    />
  </svg>
);

const RoamReviewIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6.5 3A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21H18a2 2 0 0 0 2-2V8.83a2 2 0 0 0-.59-1.41l-3.83-3.83A2 2 0 0 0 14.17 3H6.5Zm0 2h7v3a2 2 0 0 0 2 2h3v9H6.5a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5Zm2 7h7a1 1 0 1 1 0 2h-7a1 1 0 1 1 0-2Zm0 4h7a1 1 0 1 1 0 2h-7a1 1 0 1 1 0-2Z"
      fill="currentColor"
    />
  </svg>
);

const ParentMigrationIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M9.2 6.2a1 1 0 0 1 1.4 0l3.8 3.8a1 1 0 1 1-1.4 1.4L11 9.41V15a3 3 0 0 1-3 3H5a1 1 0 1 1 0-2h3a1 1 0 0 0 1-1V9.41l-2 1.99a1 1 0 1 1-1.4-1.42l3.6-3.78ZM14 6h5a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2Zm2 5h3a1 1 0 1 1 0 2h-3a1 1 0 1 1 0-2Zm-1 5h4a1 1 0 1 1 0 2h-4a1 1 0 1 1 0-2Z"
      fill="currentColor"
    />
  </svg>
);

const BuyMeACoffeeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6 7.25A2.25 2.25 0 0 1 8.25 5h5.9a3.85 3.85 0 0 1 3.85 3.85v.4h.95A2.05 2.05 0 0 1 21 11.3v.15A4.55 4.55 0 0 1 16.45 16H16a6 6 0 0 1-5.87 5H8.9A5.9 5.9 0 0 1 3 15.1V9.25A2 2 0 0 1 5 7.25h1Zm2.25-.75a.75.75 0 0 0-.75.75v7.85a4.4 4.4 0 0 0 1.4 3.23 4.37 4.37 0 0 0 1.23.86A4.5 4.5 0 0 0 14.5 15.1V8.85A2.35 2.35 0 0 0 12.15 6.5h-3.9Zm7.75 7.96h.45a3.05 3.05 0 0 0 3.05-3.05v-.11a.55.55 0 0 0-.55-.55H16v3.71Z"
      fill="currentColor"
    />
    <path
      d="M10.8 3.15c.4.18.58.66.4 1.06l-.65 1.44a.8.8 0 0 1-1.46-.66l.66-1.44c.18-.4.65-.58 1.05-.4Zm3.25.1c.37.23.48.72.25 1.1l-.95 1.5a.8.8 0 1 1-1.35-.85l.95-1.5a.8.8 0 0 1 1.1-.25Z"
      fill="currentColor"
      opacity="0.72"
    />
  </svg>
);

const getContextLines = (blockInfo: BlockInfo) => {
  const pageTitle = blockInfo.breadcrumbs.find((crumb) => crumb[':node/title'])?.[':node/title'];
  return [pageTitle, ...blockInfo.parentBlocks].filter(
    (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index
  );
};

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

const getCalendarDayDelta = (targetDate: Date, referenceDate = new Date()) => {
  const target = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  );
  const reference = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate()
  );

  return Math.round((target.getTime() - reference.getTime()) / (24 * 60 * 60 * 1000));
};

const getCompactDueLabel = (session: Session) => {
  if (!session.nextDueDate) return 'New';

  const dayDelta = getCalendarDayDelta(session.nextDueDate);
  if (dayDelta === 0) return 'Today';
  if (dayDelta < 0) {
    if (Math.abs(dayDelta) === 1) return 'Due yesterday';
    return `Due ${Math.abs(dayDelta)}d ago`;
  }

  if (dayDelta === 1) return 'In 1d';
  return `In ${dayDelta}d`;
};

const getCompactNextReviewLabel = (session: Session) => {
  if (!session.nextDueDate) return 'New';

  const dayDelta = Math.max(getCalendarDayDelta(session.nextDueDate), 0);
  if (dayDelta === 0) return 'Today';
  if (dayDelta < 7) return `${dayDelta}d`;
  if (dayDelta < 30) return `${Math.round(dayDelta / 7)}w`;
  if (dayDelta < 365) return `${Math.round(dayDelta / 30)}mo`;
  return `${Math.round(dayDelta / 365)}y`;
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
