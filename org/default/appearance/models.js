  // The catalog follows the selected organization's engine defaults.
  var WORKDIR = '__WP_WORKDIR__', PERM = '__WP_PERMISSION__';
  var rawFetch = window.fetch;
  var MODELS = {
    codex: [{ id: '__CODEX_MODEL__', also: ['default'], key: '__CODEX_MODEL__', name: '__CODEX_MODEL__' }],
    claude: [{ id: '__CLAUDE_MODEL__', also: ['default'], key: '__CLAUDE_MODEL__', name: '__CLAUDE_MODEL__' }]
  };
  var SAME_MODEL = { codex: { 'default': '__CODEX_MODEL__' }, claude: { 'default': '__CLAUDE_MODEL__' } };
  function sameModel(backend, id) { return (SAME_MODEL[backend] || {})[id] || id; }
