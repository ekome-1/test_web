# Raicho C Leak Scout

A browser-only C memory-leak heuristic. The directory walker and UI are small
browser JavaScript helpers; allocation/free tokenization and candidate tracking
run in Raicho compiled by the SelfHost compiler to WebAssembly. Source files are
read locally and are not uploaded.

Build from the `RaichoSelfHost` directory:

```sh
./bin/rai emit-target Examples/selfhost_homepage/homepage.rai \
  -o Examples/selfhost_homepage/homepage.wasm
```

Serve the generated `.js` and `.wasm` over HTTP (ES modules and WASM do not work
reliably from `file://`):

```sh
cd Examples/selfhost_homepage
python3 -m http.server 8000
```

Open `http://localhost:8000`. Drop a project folder or use “フォルダを選択”.
The page recursively collects `.c` and `.h` files and passes them to the Raicho
WASM analyzer. It accepts up to 200 files, 2 MiB per file, and 16 MiB total.

The current heuristic tokenizes C while ignoring comments and string/character
literals. It tracks assignments from `malloc`, `calloc`, `realloc`, `reallocarray`,
`aligned_alloc`, `strdup`, and `strndup`; `free(pointer)`, `return pointer`, and
recognized release-function calls in the same top-level brace scope can dispose
of a candidate. Direct aliases and alias chains (such as `q = p; r = q; free(r);`)
are followed. An `if/else` suppresses a finding only when both arms release the
candidate; an allocation and release within the same branch is also understood.
It reports a pointer overwritten by another allocation before a proven release.

Release functions are summarized within their defining file when a parameter is
passed directly to `free`, either unconditionally or in both arms of a top-level
`if/else`; calls to that parameter position are then treated as releases.
Conditional aliases are accepted only when used within the same branch context.

This is intentionally not a proof of leak-freedom. Releases inside loops are not
considered guaranteed, and the analyzer does not model struct-member ownership,
pointer arithmetic or casts, function pointers, `goto`/`switch`, preprocessor
expansion, or release-function summaries across files. Complex C syntax can still
produce false positives or missed leaks. Use a full C analyzer and runtime
sanitizers for security- or safety-critical code.

Run the WebAssembly fixture tests after rebuilding:

```sh
node --test Tests/test_leak_detector.mjs
```

The supported directory-drop API fallbacks can be tested with:

```sh
node --test Tests/test_directory_drop.mjs
```
