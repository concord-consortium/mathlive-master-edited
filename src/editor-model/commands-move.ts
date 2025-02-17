import { isBrowser } from '../common/capabilities';

import { Atom, BranchName } from '../core/atom';
import { SubsupAtom } from '../core-atoms/subsup';
import { register } from '../editor/commands';

import { move, skip } from './commands';
import type { ModelPrivate } from './model-private';

export function moveAfterParent(model: ModelPrivate): boolean {
  const previousPosition = model.position;
  const parent = model.at(previousPosition).parent;
  // Do nothing if at the root.
  if (!parent?.parent) {
    model.announce('plonk');
    return false;
  }

  model.position = model.offsetOf(parent);
  model.mathfield.stopCoalescingUndo();
  model.announce('move', previousPosition);
  return true;
}

function superscriptDepth(model: ModelPrivate): number {
  let result = 0;
  let atom: Atom | undefined = model.at(model.position);
  let wasSuperscript = false;
  while (atom) {
    if (
      !atom.hasEmptyBranch('superscript') ||
      !atom.hasEmptyBranch('subscript')
    )
      result += 1;

    if (!atom.hasEmptyBranch('superscript')) wasSuperscript = true;
    else if (!atom.hasEmptyBranch('subscript')) wasSuperscript = false;

    atom = atom.parent;
  }

  return wasSuperscript ? result : 0;
}

function subscriptDepth(model: ModelPrivate): number {
  let result = 0;
  let atom: Atom | undefined = model.at(model.position);
  let wasSubscript = false;
  while (atom) {
    if (
      !atom.hasEmptyBranch('superscript') ||
      !atom.hasEmptyBranch('subscript')
    )
      result += 1;

    if (!atom.hasEmptyBranch('superscript')) wasSubscript = false;
    else if (!atom.hasEmptyBranch('subscript')) wasSubscript = true;

    atom = atom.parent;
  }

  return wasSubscript ? result : 0;
}

/**
 * Switch the cursor to the superscript and select it. If there is no subscript
 * yet, create one.
 */
function moveToSuperscript(model: ModelPrivate): boolean {
  model.collapseSelection();
  if (superscriptDepth(model) >= model.mathfield.options.scriptDepth[1]) {
    model.announce('plonk');
    return false;
  }

  let target = model.at(model.position);

  if (target.subsupPlacement === undefined) {
    // This atom can't have a superscript/subscript:
    // add an adjacent `msubsup` atom instead.
    if (target.rightSibling?.type !== 'subsup') {
      target.parent!.addChildAfter(
        new SubsupAtom({ style: target.computedStyle }),
        target
      );
    }

    target = target.rightSibling;
  }

  // Ensure there is a superscript branch
  target.createBranch('superscript');
  model.setSelection(
    model.getSiblingsRange(model.offsetOf(target.superscript![0]))
  );

  return true;
}

/**
 * Switch the cursor to the subscript and select it. If there is no subscript
 * yet, create one.
 */
function moveToSubscript(model: ModelPrivate): boolean {
  model.collapseSelection();
  if (subscriptDepth(model) >= model.mathfield.options.scriptDepth[0]) {
    model.announce('plonk');
    return false;
  }

  let target = model.at(model.position);

  if (target.subsupPlacement === undefined) {
    // This atom can't have a superscript/subscript:
    // add an adjacent `msubsup` atom instead.
    if (model.at(model.position + 1)?.type !== 'subsup') {
      target.parent!.addChildAfter(
        new SubsupAtom({ style: model.at(model.position).computedStyle }),
        target
      );
    }

    target = model.at(model.position + 1);
  }

  // Ensure there is a subscript branch
  target.createBranch('subscript');
  model.setSelection(
    model.getSiblingsRange(model.offsetOf(target.subscript![0]))
  );
  return true;
}

/**
 * Return an array of tabbable elements, approximately in the order a browser
 * would (the browsers are inconsistent), which is first by accounting
 * for non-null tabIndex, then null tabIndex, then document order of focusable
 * elements.
 */
function getTabbableElements(): HTMLElement[] {
  function tabbable(element: HTMLElement) {
    const regularTabbables: HTMLElement[] = [];
    const orderedTabbables: {
      documentOrder: number;
      tabIndex: number;
      node: HTMLElement;
    }[] = [];

    const candidates = [
      ...element.querySelectorAll<HTMLElement>(`input, select, textarea, a[href], button,
        [tabindex], audio[controls], video[controls],
        [contenteditable]:not([contenteditable="false"]), details>summary`),
    ].filter(isNodeMatchingSelectorTabbable);
    candidates.forEach((candidate, i) => {
      const candidateTabindex = getTabindex(candidate);
      if (candidateTabindex === 0) regularTabbables.push(candidate);
      else {
        orderedTabbables.push({
          documentOrder: i,
          tabIndex: candidateTabindex,
          node: candidate,
        });
      }
    });

    return orderedTabbables
      .sort((a, b) =>
        a.tabIndex === b.tabIndex
          ? a.documentOrder - b.documentOrder
          : a.tabIndex - b.tabIndex
      )
      .map((a) => a.node)
      .concat(regularTabbables);
  }

  function isNodeMatchingSelectorTabbable(element: HTMLElement): boolean {
    if (
      !isNodeMatchingSelectorFocusable(element) ||
      isNonTabbableRadio(element) ||
      getTabindex(element) < 0
    )
      return false;

    return true;
  }

  function isNodeMatchingSelectorFocusable(node) {
    if (
      node.disabled ||
      (node.type === 'hidden' && node.tagName.toUpperCase() === 'INPUT') ||
      isHidden(node)
    )
      return false;

    return true;
  }

  function getTabindex(node: HTMLElement): number {
    const tabindexAttr = Number.parseInt(
      node.getAttribute('tabindex') ?? 'NaN',
      10
    );

    if (!Number.isNaN(tabindexAttr)) return tabindexAttr;

    // Browsers do not return `tabIndex` correctly for contentEditable nodes;
    // so if they don't have a tabindex attribute specifically set, assume it's 0.
    if (node.contentEditable === 'true') return 0;

    // In Chrome, <audio controls/> and <video controls/> elements get a default
    //  `tabIndex` of -1 when the 'tabindex' attribute isn't specified in the DOM,
    //  yet they are still part of the regular tab order; in FF, they get a default
    //  `tabIndex` of 0; since Chrome still puts those elements in the regular tab
    //  order, consider their tab index to be 0
    if (
      (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') &&
      node.getAttribute('tabindex') === null
    )
      return 0;

    return node.tabIndex;
  }

  function isNonTabbableRadio(node: HTMLElement): boolean {
    return (
      node.tagName.toUpperCase() === 'INPUT' &&
      (node as HTMLInputElement).type === 'radio' &&
      !isTabbableRadio(node as HTMLInputElement)
    );
  }

  function getCheckedRadio(nodes, form) {
    for (const node of nodes)
      if (node.checked && node.form === form) return node;

    return null;
  }

  function isTabbableRadio(node: HTMLInputElement): boolean {
    if (!node.name) return true;

    const radioScope = node.form ?? node.ownerDocument;
    const radioSet = radioScope.querySelectorAll(
      'input[type="radio"][name="' + node.name + '"]'
    );
    const checked = getCheckedRadio(radioSet, node.form);
    return !checked || checked === node;
  }

  function isHidden(element: HTMLElement) {
    if (
      !isBrowser() ||
      element === document.activeElement ||
      element.contains(document.activeElement)
    )
      return false;

    if (getComputedStyle(element).visibility === 'hidden') return true;

    // Note that browsers generally don't consider the bounding rect
    // as a criteria to determine if an item is focusable, but we want
    // to exclude the invisible textareas used to capture keyoard input.
    const bounds = element.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return true;

    while (element) {
      if (getComputedStyle(element).display === 'none') return true;
      element = element.parentElement!;
    }

    return false;
  }

  if (!isBrowser()) return [];
  return tabbable(document.body);
}

/**
 * Move to the next/previous leap target: placeholder, editable prompt or
 * empty child list.
 * @return `false` if no placeholder found and did not move
 */
function leap(
  model: ModelPrivate,
  dir: 'forward' | 'backward',
  callHooks = true
): boolean {
  const dist = dir === 'forward' ? 1 : -1;

  // If we're already at a placeholder, move by one more (the placeholder
  // is right after the insertion point)
  if (model.at(model.anchor).type === 'placeholder') move(model, dir);

  let origin: number;

  // If we're in a prompt, start looking after/before the prompt
  const parentPrompt = model.at(model.anchor).parentPrompt;
  if (parentPrompt) {
    if (dir === 'forward') origin = model.offsetOf(parentPrompt) + 1;
    else origin = model.offsetOf(parentPrompt.leftSibling);
  } else origin = Math.max(model.position + dist, 0);

  // Candidate leap targets are atoms of type 'placeholder' or
  // 'prompt' or empty children list (except for the root:
  // if the root is empty, it is not a valid leap target)
  const target = model.findAtom(
    (atom) =>
      atom.type === 'placeholder' ||
      atom.type === 'prompt' ||
      (!model.mathfield.readOnly &&
        atom.treeDepth > 2 &&
        atom.isFirstSibling &&
        atom.isLastSibling),
    origin,
    dir
  );

  // If no leap target was found, call handler or move to the next focusable
  // element in the document
  if (
    !target ||
    (dir === 'forward' && model.offsetOf(target) < origin) ||
    (dir === 'backward' && model.offsetOf(target) > origin)
  ) {
    const handled =
      !callHooks ||
      !(
        model.mathfield.host?.dispatchEvent(
          new CustomEvent('move-out', {
            detail: { direction: dir },
            cancelable: true,
            bubbles: true,
            composed: true,
          })
        ) ?? true
      );
    if (handled) {
      model.announce('plonk');
      return false;
    }

    const tabbable = getTabbableElements();

    // If there are no other elements to focus, plonk.
    if (!document.activeElement || tabbable.length <= 1) {
      model.announce('plonk');
      return false;
    }

    //
    // Focus on next/previous tabbable element
    //
    let index = tabbable.indexOf(document.activeElement as HTMLElement) + dist;
    if (index < 0) index = tabbable.length - 1;
    if (index >= tabbable.length) index = 0;

    tabbable[index].focus();

    model.mathfield.stopCoalescingUndo();
    return true;
  }

  // Set the selection to the next placeholder
  const previousPosition = model.position;
  if (target.type === 'prompt') {
    model.setSelection(
      model.offsetOf(target.firstChild),
      model.offsetOf(target.lastChild)
    );
  } else {
    const newPosition = model.offsetOf(target);
    if (target.type === 'placeholder')
      model.setSelection(newPosition - 1, newPosition);
    else model.position = newPosition;
  }
  model.announce('move', previousPosition);

  model.mathfield.stopCoalescingUndo();
  return true;
}

/**
 * If cursor is currently in:
 * - superscript: move to subscript, creating it if necessary
 * - subscript: move to superscript, creating it if necessary
 * - numerator: move to denominator
 * - denominator: move to numerator
 * - otherwise: move to superscript
 */
register(
  {
    moveToOpposite: (model: ModelPrivate): boolean => {
      const OPPOSITE_RELATIONS = {
        superscript: 'subscript',
        subscript: 'superscript',
        above: 'below',
        below: 'above',
      };
      const cursor = model.at(model.position);
      const { parent } = cursor;
      if (!parent) {
        model.announce('plonk');
        return false;
      }

      const relation = cursor.parentBranch;
      let oppositeRelation: BranchName | undefined;
      if (typeof relation === 'string')
        oppositeRelation = OPPOSITE_RELATIONS[relation];

      if (!oppositeRelation) {
        const result = cursor.subsupPlacement
          ? moveToSubscript(model)
          : moveToSuperscript(model);

        model.mathfield.stopCoalescingUndo();
        return result;
      }

      if (!parent.branch(oppositeRelation)) {
        // Don't have children of the opposite relation yet
        // Add them
        parent.createBranch(oppositeRelation);
      }

      const result = model.setSelection(
        model.getBranchRange(model.offsetOf(parent), oppositeRelation)
      );
      model.mathfield.stopCoalescingUndo();
      return result;
    },
    moveBeforeParent: (model: ModelPrivate): boolean => {
      const { parent } = model.at(model.position);
      if (!parent) {
        model.announce('plonk');
        return false;
      }

      model.position = model.offsetOf(parent);
      model.mathfield.stopCoalescingUndo();
      return true;
    },
    moveAfterParent: (model: ModelPrivate): boolean => moveAfterParent(model),

    moveToNextChar: (model: ModelPrivate): boolean => move(model, 'forward'),
    moveToPreviousChar: (model: ModelPrivate): boolean =>
      move(model, 'backward'),
    moveUp: (model: ModelPrivate): boolean => move(model, 'upward'),
    moveDown: (model: ModelPrivate): boolean => move(model, 'downward'),
    moveToNextWord: (model: ModelPrivate): boolean => skip(model, 'forward'),
    moveToPreviousWord: (model: ModelPrivate): boolean =>
      skip(model, 'backward'),
    moveToGroupStart: (model: ModelPrivate): boolean => {
      const pos = model.offsetOf(model.at(model.position).firstSibling);
      if (pos === model.position) {
        model.announce('plonk');
        return false;
      }

      model.position = pos;
      model.mathfield.stopCoalescingUndo();
      return true;
    },
    moveToGroupEnd: (model: ModelPrivate): boolean => {
      const pos = model.offsetOf(model.at(model.position).lastSibling);
      if (pos === model.position) {
        model.announce('plonk');
        return false;
      }

      model.position = pos;
      model.mathfield.stopCoalescingUndo();
      return true;
    },
    moveToMathfieldStart: (model: ModelPrivate): boolean => {
      if (model.position === 0) {
        model.announce('plonk');
        return false;
      }

      model.position = 0;
      model.mathfield.stopCoalescingUndo();
      return true;
    },
    moveToMathfieldEnd: (model: ModelPrivate): boolean => {
      if (model.position === model.lastOffset) {
        model.announce('plonk');
        return false;
      }

      model.position = model.lastOffset;
      model.mathfield.stopCoalescingUndo();
      return true;
    },
    moveToSuperscript: (model: ModelPrivate): boolean =>
      moveToSuperscript(model),
    moveToSubscript: (model: ModelPrivate): boolean => moveToSubscript(model),
  },
  { target: 'model', changeSelection: true }
);

register(
  {
    moveToNextPlaceholder: (model) => leap(model, 'forward'),
    moveToPreviousPlaceholder: (model) => leap(model, 'backward'),
  },
  { target: 'model', changeSelection: true, audioFeedback: 'return' }
);
