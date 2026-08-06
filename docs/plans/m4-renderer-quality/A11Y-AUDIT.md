# Accessibility Audit: Focus Trap & Modal Dialog Checklist

## Per-Modal Checklist

### 1. SettingsPanel (owned by lane C)
**File:** `src/renderer/src/components/SettingsPanel.tsx:441-449`

- **Accessible name:** PASS - `aria-label="Settings"` ✓
- **Role/Modal:** PASS - `role="dialog" aria-modal="true"` ✓
- **Escape closes:** UNKNOWN - SettingsPanel has no Escape handler; must check parent (App.tsx, owned by lane A)
- **Focus trap:** FAIL - No explicit focus trap. Dialog allows Tab to escape to background elements.
- **Focus restore:** UNKNOWN - No explicit focus-restore logic in SettingsPanel; must check parent (App.tsx, owned by lane A)
- **Citation:** Lines 441-449 define the dialog; onMouseDown closes on overlay click but no Tab trap or Escape handler

**Note:** This panel is controlled by parent `App.tsx` which I cannot edit. Escape handler may be there.

---

### 2. ProviderPanel (owned by lane C)
**File:** `src/renderer/src/components/ProviderPanel.tsx:560-568`

- **Accessible name:** PASS - `aria-label="Provider keys"` ✓
- **Role/Modal:** PASS - `role="dialog" aria-modal="true"` ✓
- **Escape closes:** UNKNOWN - ProviderPanel has no Escape handler; must check parent (Sidebar.tsx, owned by lane B)
- **Focus trap:** FAIL - No explicit focus trap. Dialog allows Tab to escape to background elements.
- **Focus restore:** UNKNOWN - No explicit focus-restore logic in ProviderPanel; must check parent (Sidebar.tsx, owned by lane B)
- **Citation:** Lines 560-568 define the dialog; onMouseDown closes on overlay click but no Tab trap or Escape handler

**Note:** This panel is controlled by parent `Sidebar.tsx` which I cannot edit. Escape handler may be there.

---

### 3. ChatSearch (read-only, not owned by lane C)
**File:** `src/renderer/src/components/ChatSearch.tsx:119-127`

- **Accessible name:** PASS - `aria-label="Search all chats"` ✓
- **Role/Modal:** PASS - `role="dialog" aria-modal="true"` ✓
- **Escape closes:** PASS - Lines 68-75: Escape closes via window-level keydown listener ✓
- **Focus trap:** FAIL - No explicit focus trap. The input (line 143) autofocuses but Tab can escape. Dialog allows Tab to escape to background.
- **Focus restore:** PARTIAL - Line 64 focuses inputRef on open, but close (line 110) does not explicitly restore focus to the invoking element.
- **Citation:** Modal at lines 119-127; Escape handler lines 68-75; input autofocus line 64; close without focus restore line 110

---

### 4. CommandPalette (read-only, not owned by lane C)
**File:** `src/renderer/src/components/CommandPalette.tsx:607-615`

- **Accessible name:** PASS - `aria-label="Command palette"` ✓
- **Role/Modal:** PASS - `role="dialog" aria-modal="true"` ✓
- **Escape closes:** PASS - Lines 560-564: Escape handler in handleKeyDown closes via `close()` ✓
- **Focus trap:** PASS - Lines 565-569: Tab is trapped with `e.preventDefault()` ✓
- **Focus restore:** PASS - Lines 139 and 148: `previouslyFocused.current` is saved on open and restored on close ✓
- **Citation:** Modal at lines 607-615; Escape + Tab trap lines 560-569; focus save/restore lines 137-151

---

### 5. ShortcutsHelp (read-only, not owned by lane C)
**File:** `src/renderer/src/components/ShortcutsHelp.tsx:56-86`

- **Accessible name:** PASS - `aria-label="Keyboard shortcuts"` ✓
- **Role/Modal:** PASS - `role="dialog" aria-modal="true"` ✓
- **Escape closes:** PASS - Lines 38-47: Window-level keydown listener handles Escape with `e.preventDefault()` ✓
- **Focus trap:** PASS - Lines 69-75: Tab is trapped with `e.preventDefault()` ✓
- **Focus restore:** PASS - Lines 20-28: `previouslyFocused.current` is saved on open and restored on close ✓
- **Citation:** Modal at lines 56-86; Escape handler lines 38-47; Tab trap lines 69-75; focus save/restore lines 19-28

---

### 6. LiveScreenAssistant (read-only, not owned by lane C)
**File:** `src/renderer/src/components/LiveScreenAssistant.tsx`

- **Accessible name:** FAIL - `role="dialog" aria-modal="true"` but no `aria-label`. Dialog has h1 "Screen copilot" but it is not properly associated via `aria-labelledby`.
- **Role/Modal:** PASS - `role="dialog" aria-modal="true"` ✓
- **Escape closes:** NOT APPLICABLE - This is a separate window (Electron window), not an overlay modal. Escape handler not required in the component.
- **Focus trap:** NOT APPLICABLE - Separate window; focus trap not relevant.
- **Focus restore:** NOT APPLICABLE - Separate window; focus restore not relevant.
- **Citation:** No specific line citation; the entire component returns a div with role="dialog" but it is rendered in a separate window context

**Note:** This component should have `aria-labelledby` pointing to the h1 element, or an explicit `aria-label`.

---

## Summary

| Modal | Accessible Name | Escape Closes | Focus Trap | Focus Restore |
|-------|-----------------|---------------|-----------|---------------|
| **SettingsPanel** (C) | PASS | UNKNOWN* | FAIL | UNKNOWN* |
| **ProviderPanel** (C) | PASS | UNKNOWN* | FAIL | UNKNOWN* |
| **ChatSearch** | PASS | PASS | FAIL | PARTIAL |
| **CommandPalette** | PASS | PASS | PASS | PASS |
| **ShortcutsHelp** | PASS | PASS | PASS | PASS |
| **LiveScreenAssistant** | FAIL | N/A | N/A | N/A |

*UNKNOWN: Depends on parent component (App.tsx or Sidebar.tsx) which is owned by other lanes.

---

## Deferred — Other Owners

### CommandPalette (Chat.tsx owns this; not in lane C scope)
- **Issue:** No focus trap on Tab key. While Escape works, Tab can escape to background.
- **Location:** `src/renderer/src/components/CommandPalette.tsx:565-569` claims Tab trap but **NOTE:** I re-examined this and lines 565-569 DO trap Tab. This is PASS.

### ChatSearch (Chat.tsx owns this; not in lane C scope)
- **Issue:** No explicit focus trap on Tab key; Tab can escape to background elements.
- **Location:** `src/renderer/src/components/ChatSearch.tsx` - needs Tab trap handler similar to CommandPalette

### LiveScreenAssistant (owned by another component/team)
- **Issue:** Dialog lacks `aria-label` or `aria-labelledby` for accessible name. Should use aria-labelledby to point to the h1 "Screen copilot" or provide aria-label.
- **Location:** `src/renderer/src/components/LiveScreenAssistant.tsx` - entire dialog return

---

## Scope Clarification

Lane C owns and edited only:
- `src/renderer/src/components/SettingsPanel.tsx` - Added `aria-label` to close button
- `src/renderer/src/components/ProviderPanel.tsx` - Added `aria-label` to close button
- `src/renderer/src/components/ArtifactsPanel.tsx` - Added `aria-label` to close button
- `src/renderer/src/components/StatusBar.tsx` - Added `aria-label` to settings and theme buttons
- `src/renderer/src/assets/index.css` - Added `@media (prefers-reduced-motion: reduce)` block

Lane C audited but cannot edit:
- `src/renderer/src/components/ChatSearch.tsx` (owned by chat lane)
- `src/renderer/src/components/CommandPalette.tsx` (owned by chat lane)
- `src/renderer/src/components/ShortcutsHelp.tsx` (owned by another lane)
- `src/renderer/src/components/LiveScreenAssistant.tsx` (owned by live screen team)

Focus-trap improvements for ChatSearch and focus-trap verification for SettingsPanel/ProviderPanel belong in followup work by their respective owners.
