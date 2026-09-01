// Container app page script.
//
// The native side calls show(enabled, useSettingsInsteadOfPreferences) after the
// page loads, and openPreferences() posts back through the `controller` message
// handler. That contract comes from Apple's template and ViewController.swift
// still expects exactly these two names -- renaming either silently breaks the
// only interactive thing this window does.

function show(enabled, useSettingsInsteadOfPreferences) {
  // macOS 13 renamed Preferences to Settings. The native side tells us which
  // wording the running system uses so the instructions match what the user
  // will actually see.
  const place = useSettingsInsteadOfPreferences ? 'Safari Settings' : 'Safari Preferences';
  const button = document.querySelector('button.open-preferences');
  if (button) button.textContent = `Open ${place} → Extensions…`;

  const unknown = document.querySelector('.state-unknown');
  if (unknown) unknown.textContent = `Turn on the ClosiqSync extension in ${place}.`;

  if (typeof enabled === 'boolean') {
    document.body.classList.toggle('state-on', enabled);
    document.body.classList.toggle('state-off', !enabled);
  } else {
    document.body.classList.remove('state-on');
    document.body.classList.remove('state-off');
  }
}

function openPreferences() {
  webkit.messageHandlers.controller.postMessage('open-preferences');
}

document.querySelector('button.open-preferences').addEventListener('click', openPreferences);
