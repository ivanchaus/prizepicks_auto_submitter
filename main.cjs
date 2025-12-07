import('file://' + __dirname + '/main.mjs')
  .catch(err => {
    console.error('Failed to load main.mjs:', err);
  });