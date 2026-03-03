import * as React from 'react';
import * as Blueprint from '@blueprintjs/core';
import styled from '@emotion/styled';
import Tooltip from '~/components/Tooltip';
import { SessionFilterConfig } from '~/queries/data';

interface Props {
  sessionFilter: SessionFilterConfig;
  onSessionFilterChange: (filter: SessionFilterConfig) => void;
}

const SessionFilter = ({ sessionFilter, onSessionFilterChange }: Props) => {
  const [isOpen, setIsOpen] = React.useState(false);

  const activeFilterCount =
    sessionFilter.includeTags.length + sessionFilter.excludeTags.length;

  return (
    <Blueprint.Popover
      isOpen={isOpen}
      onInteraction={(nextState) => setIsOpen(nextState)}
      position="bottom"
      minimal
      content={
        <FilterPopoverContent
          sessionFilter={sessionFilter}
          onSessionFilterChange={onSessionFilterChange}
        />
      }
    >
      {/* @ts-ignore */}
      <Tooltip content="Session Filters" placement="bottom">
        <FilterButton
          className="px-1 cursor-pointer"
          onClick={() => setIsOpen(!isOpen)}
        >
          <Blueprint.Icon
            icon="filter"
            className={activeFilterCount > 0 ? 'opacity-100' : 'opacity-60'}
          />
          {activeFilterCount > 0 && (
            <FilterCount className="bp3-tag bp3-minimal bp3-intent-primary bp3-round">
              {activeFilterCount}
            </FilterCount>
          )}
        </FilterButton>
      </Tooltip>
    </Blueprint.Popover>
  );
};

const FilterPopoverContent = ({
  sessionFilter,
  onSessionFilterChange,
}: {
  sessionFilter: SessionFilterConfig;
  onSessionFilterChange: (filter: SessionFilterConfig) => void;
}) => {
  const handleExcludeChange = (values: React.ReactNode[]) => {
    onSessionFilterChange({
      ...sessionFilter,
      excludeTags: values.filter((v): v is string => typeof v === 'string'),
    });
  };

  const handleIncludeChange = (values: React.ReactNode[]) => {
    onSessionFilterChange({
      ...sessionFilter,
      includeTags: values.filter((v): v is string => typeof v === 'string'),
    });
  };

  const clearAll = () => {
    onSessionFilterChange({ includeTags: [], excludeTags: [] });
  };

  const hasAnyFilter = sessionFilter.includeTags.length > 0 || sessionFilter.excludeTags.length > 0;

  return (
    <FilterContent onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-sm">Session Filters</span>
        {hasAnyFilter && (
          <Blueprint.Button minimal small onClick={clearAll} className="bp3-small">
            Clear all
          </Blueprint.Button>
        )}
      </div>

      <div className="mb-3">
        <label className="text-xs font-medium" style={{ color: '#5c7080' }}>
          Exclude (metadata tags)
        </label>
        <p className="text-xs mb-1" style={{ color: '#8a9ba8' }}>
          Hide cards tagged in their memo data (e.g. memo/archived)
        </p>
        <Blueprint.TagInput
          values={sessionFilter.excludeTags}
          onChange={handleExcludeChange}
          addOnBlur
          addOnPaste
          placeholder="e.g. memo/archived"
          tagProps={{ minimal: true, intent: 'danger' }}
          separator=","
          className="filter-tag-input"
        />
      </div>

      <div>
        <label className="text-xs font-medium" style={{ color: '#5c7080' }}>
          Include (content tags)
        </label>
        <p className="text-xs mb-1" style={{ color: '#8a9ba8' }}>
          Only show cards that reference these tags (or are nested under them)
        </p>
        <Blueprint.TagInput
          values={sessionFilter.includeTags}
          onChange={handleIncludeChange}
          addOnBlur
          addOnPaste
          placeholder="e.g. readwise, chapter-5"
          tagProps={{ minimal: true, intent: 'success' }}
          separator=","
          className="filter-tag-input"
        />
      </div>
    </FilterContent>
  );
};

const FilterButton = styled.div`
  display: flex;
  align-items: center;
  position: relative;
`;

const FilterCount = styled.span`
  &.bp3-tag {
    font-size: 9px;
    padding: 0 4px;
    min-height: 14px;
    min-width: 14px;
    line-height: 14px;
    margin-left: 2px;
  }
`;

const FilterContent = styled.div`
  padding: 12px;
  min-width: 280px;
  max-width: 350px;

  .filter-tag-input .bp3-tag-input-values {
    min-height: 30px;
  }

  .filter-tag-input .bp3-input-ghost {
    font-size: 12px;
  }
`;

export default SessionFilter;
