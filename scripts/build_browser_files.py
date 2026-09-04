from pathlib import Path

project = Path(__file__).resolve().parents[1]
app = project / 'app.js'
app_browser = project / 'app.browser.js'
data_json = project / 'data' / 'eco-reference-data.json'
data_global = project / 'data' / 'eco-reference-data-global.js'

# Keep app.js as the tested ES module source. The browser build removes ES-module
# exports so index.html can also run directly from a file share without CORS/fetch errors.
app_browser.write_text(app.read_text().replace('export ', ''))
data_global.write_text('window.ECO_REFERENCE_DATA = ' + data_json.read_text() + ';\n')
print(f'wrote {app_browser} ({app_browser.stat().st_size} bytes)')
print(f'wrote {data_global} ({data_global.stat().st_size} bytes)')
