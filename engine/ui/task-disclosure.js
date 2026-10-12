export function createTaskDisclosure(initialExpanded = false) {
  let expanded = Boolean(initialExpanded);
  return {
    get expanded() { return expanded; },
    expand() { expanded = true; return expanded; },
    collapse() { expanded = false; return expanded; },
    toggle() { expanded = !expanded; return expanded; },
    onPoll() { return expanded; },
  };
}
