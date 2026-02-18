import React, { useMemo, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilterTypes } from '@libs/filterInputs';
import type { Filter } from '@libs/filterInputs';

type AutocompleteMultiFilterProps = {
  filter: {
    key: string;
    filter: Filter<FilterTypes.AutocompleteMulti>;
  };
  value: string[];
  set: (value: string[]) => void;
};

const normalize = (v: string) => v.trim().toLocaleLowerCase();

export function AutocompleteMultiFilter({
  filter,
  value,
  set,
}: AutocompleteMultiFilterProps) {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(
    () => new Set(value.map(item => normalize(item))),
    [value],
  );

  const suggestions = useMemo(() => {
    const normalizedQuery = normalize(query);
    return filter.filter.options
      .filter(option => {
        const optionNorm = normalize(option.value);
        if (selectedSet.has(optionNorm)) return false;
        if (!normalizedQuery) return true;
        return (
          normalize(option.label).includes(normalizedQuery) ||
          optionNorm.includes(normalizedQuery)
        );
      })
      .slice(0, 20);
  }, [filter.filter.options, query, selectedSet]);

  const addTag = (rawTag: string) => {
    const tag = rawTag.trim();
    if (!tag) return;
    const norm = normalize(tag);
    if (selectedSet.has(norm)) {
      setQuery('');
      return;
    }
    set([...value, tag]);
    setQuery('');
  };

  const removeTag = (tag: string) => {
    const norm = normalize(tag);
    set(value.filter(v => normalize(v) !== norm));
  };

  return (
    <div className="space-y-3">
      <Label htmlFor={filter.key} className="text-sm font-medium">
        {filter.filter.label}
      </Label>
      <Input
        id={filter.key}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTag(query);
          }
        }}
        placeholder={`Search ${filter.filter.label.toLowerCase()}...`}
      />

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.map(tag => (
            <Badge key={tag} variant="secondary" className="gap-1">
              <span>{tag}</span>
              <button
                type="button"
                className="ml-1 rounded-sm px-1 hover:bg-black/10"
                onClick={() => removeTag(tag)}
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map(option => (
            <Button
              key={option.value}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addTag(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
