"""Run the real personal-skill worker on a test-owned home instead of a container."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True

root, slug, action, value = sys.argv[1:]
root, value = Path(root), json.loads(value)
script = Path(__file__).resolve().parents[2] / 'image/bin/wp-skill'
loader = importlib.machinery.SourceFileLoader('wp_skill', str(script))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
store = module.SkillStore(root / slug, root / 'builtin', root / 'translations.json', root / 'uploads', root / 'shared')
try:
    result = store.run(action, value.get('name') or value.get('source'), value.get('overwrite', False))
except module.SkillError as error:
    result = error.result
print(json.dumps(result))
