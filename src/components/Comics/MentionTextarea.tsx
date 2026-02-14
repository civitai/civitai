import { useEffect, useRef, useState, useCallback, useMemo, useId } from 'react';

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  references: { id: number; name: string }[];
  placeholder?: string;
  rows?: number;
  label?: string;
}

export function MentionTextarea({
  value,
  onChange,
  references,
  placeholder,
  rows = 4,
  label,
}: MentionTextareaProps) {
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredRefs = useMemo(
    () =>
      references
        .filter((r) => r.name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
        .slice(0, 6),
    [references, mentionQuery]
  );

  const extractMention = useCallback((text: string, cursorPos: number) => {
    // Walk backwards from cursor to find @ preceded by whitespace or start-of-string
    const before = text.slice(0, cursorPos);
    const match = before.match(/(?:^|\s)@([\w\-\u00C0-\u024F]*)$/);
    if (match) {
      // Calculate start: the match includes the leading space/start, find the @ position
      const atIndex = before.lastIndexOf('@', cursorPos - 1);
      return { query: match[1], start: atIndex };
    }
    return null;
  }, []);

  const checkMention = useCallback(
    (text: string, cursorPos: number) => {
      const mention = extractMention(text, cursorPos);
      if (mention && references.length > 0) {
        setMentionQuery(mention.query);
        setMentionStart(mention.start);
        setShowDropdown(true);
        setSelectedIndex(0);
      } else {
        setShowDropdown(false);
      }
    },
    [extractMention, references.length]
  );

  const updateDropdownPosition = useCallback(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;

    // Use mirror span to measure text up to cursor
    const style = window.getComputedStyle(textarea);
    mirror.style.font = style.font;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.padding = style.padding;
    mirror.style.border = style.border;
    mirror.style.boxSizing = style.boxSizing;
    mirror.style.overflowY = 'hidden';

    const cursorPos = textarea.selectionStart;
    const textBefore = value.slice(0, cursorPos);
    mirror.textContent = textBefore;

    // Add a cursor element to measure position
    const cursor = document.createElement('span');
    cursor.textContent = '|';
    mirror.appendChild(cursor);

    const cursorRect = cursor.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    // Dynamic line height — parseFloat handles "normal", "20px", etc.
    const lineHeight = parseFloat(style.lineHeight) || parseInt(style.fontSize) * 1.2 || 20;

    // Subtract scrollTop to account for textarea scrolling
    const top = cursorRect.top - mirrorRect.top - textarea.scrollTop + lineHeight;
    const left = cursorRect.left - mirrorRect.left;

    setDropdownPos({ top, left: Math.min(left, textarea.clientWidth - 200) });
  }, [value]);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);
      checkMention(newValue, e.target.selectionStart);
    },
    [onChange, checkMention]
  );

  const handleSelect = useCallback(
    (refName: string) => {
      if (mentionStart < 0) return;
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;
      const before = value.slice(0, mentionStart);
      const after = value.slice(cursorPos);
      const newValue = `${before}@${refName}${after}`;
      onChange(newValue);
      setShowDropdown(false);

      // Set cursor position after inserted mention
      requestAnimationFrame(() => {
        const newPos = mentionStart + refName.length + 1; // +1 for @
        textarea.selectionStart = newPos;
        textarea.selectionEnd = newPos;
        textarea.focus();
      });
    },
    [mentionStart, value, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!showDropdown || filteredRefs.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredRefs.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredRefs.length) % filteredRefs.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelect(filteredRefs[selectedIndex].name);
      } else if (e.key === 'Escape') {
        setShowDropdown(false);
      }
    },
    [showDropdown, filteredRefs, selectedIndex, handleSelect]
  );

  // Update dropdown position when visible
  useEffect(() => {
    if (showDropdown) {
      updateDropdownPosition();
    }
  }, [showDropdown, value, updateDropdownPosition]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);

  // Close dropdown if filtered results become empty
  useEffect(() => {
    if (showDropdown && filteredRefs.length === 0) {
      setShowDropdown(false);
    }
  }, [showDropdown, filteredRefs.length]);

  const dropdownId = `${textareaId}-dropdown`;

  return (
    <div style={{ position: 'relative' }}>
      {label && (
        <label
          htmlFor={textareaId}
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 500,
            marginBottom: 4,
            color: 'var(--mantine-color-text)',
          }}
        >
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        ref={textareaRef}
        className="mentionTextarea"
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onClick={() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          checkMention(value, textarea.selectionStart);
        }}
        placeholder={placeholder}
        rows={rows}
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={showDropdown ? dropdownId : undefined}
        aria-autocomplete="list"
        style={{
          width: '100%',
          background: 'var(--mantine-color-body)',
          border: '1px solid var(--mantine-color-default-border)',
          borderRadius: 'var(--mantine-radius-sm)',
          padding: '8px 12px',
          fontSize: 14,
          color: 'var(--mantine-color-text)',
          fontFamily: 'inherit',
          resize: 'vertical',
          outline: 'none',
        }}
      />
      {/* Hidden mirror for caret position measurement */}
      <span
        ref={mirrorRef}
        style={{
          position: 'absolute',
          visibility: 'hidden',
          top: 0,
          left: 0,
          pointerEvents: 'none',
        }}
      />
      {showDropdown && filteredRefs.length > 0 && (
        <div
          id={dropdownId}
          ref={dropdownRef}
          role="listbox"
          style={{
            position: 'absolute',
            top: dropdownPos.top + (label ? 22 : 0),
            left: dropdownPos.left,
            background: 'var(--mantine-color-body)',
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
            zIndex: 1000,
            minWidth: 180,
            maxWidth: 280,
            overflow: 'hidden',
          }}
        >
          {filteredRefs.map((ref, i) => (
            <div
              key={ref.id}
              role="option"
              aria-selected={i === selectedIndex}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent textarea blur
                handleSelect(ref.name);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                padding: '8px 12px',
                fontSize: 13,
                cursor: 'pointer',
                background: i === selectedIndex ? 'rgba(250, 176, 5, 0.15)' : 'transparent',
                color: i === selectedIndex ? '#fab005' : 'var(--mantine-color-text)',
                fontWeight: i === selectedIndex ? 600 : 400,
              }}
            >
              @{ref.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
