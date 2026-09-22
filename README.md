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
literals, joining backslash-newline splices first. It tracks assignments from
`malloc`, `calloc`, `realloc`, `reallocarray`,
`aligned_alloc`, `strdup`, and `strndup`; `free(pointer)`, a direct
`return pointer`/alias, and recognized release-function calls in the same
top-level brace scope can dispose of a candidate. A return transfers ownership
only when the returned expression is exactly the tracked pointer or a direct
alias; merely mentioning it in a conditional or pointer-arithmetic expression
does not suppress a leak. Return/release branches suppress a finding only when
all represented paths transfer or release ownership. Direct aliases and alias
chains (such as `q = p; r = q; free(r);`) are followed. An `if/else` suppresses
a finding only when both arms release or transfer the candidate; an allocation
and release within the same branch is also understood.
It reports a pointer overwritten by another allocation before a proven release.
`reallocarray` is analyzed with the same move/failure ownership rules as
`realloc`. It warns when a direct `p = realloc(p, size)` assignment can lose
the original pointer on allocation failure; a temporary-pointer realloc pattern is not
reported by this specific heuristic. Passing a directly tracked freed pointer
or one of its direct aliases to `realloc` is reported as a use-after-free
candidate. A temporary realloc result guarded by a simple non-null `if (tmp)`
is modeled as existing only on the success arm; the original pointer remains
owned on the failure arm, so both paths must release or transfer their owner.
An ignored standalone `realloc(p, size);` result is also reported because the
successful result may move while the old pointer becomes invalid. Repeated
`free(NULL)` and `free(0)` are not treated as double frees.
Passing a detected stack array to `realloc` or `reallocarray` is reported as
`MEMORY|INVALID_REALLOC|...|realloc called on a stack array`.
Direct aliases of stack arrays are followed for this check as well.
The check also applies when the reallocation result is assigned to another
pointer variable, including when the input is a direct alias of the stack array.
The same diagnostic class reports simple non-pointer stack values passed to
these functions as `...|realloc called on a non-pointer stack value`.
Pointers initialized from string literals are likewise rejected by
`realloc` and `reallocarray`.
Uninitialized pointer arguments are rejected in both direct and result-assignment
forms as `...|realloc called on an uninitialized pointer`.
It also flags simple same-scope array-index, unary-dereference, function-
argument, and control-condition reads after `free(p)`, including pointers
embedded in parenthesized argument expressions such as `consume(1 + (p + 1))`.
Reading a freed pointer in `if (p)` is reported even when the condition appears
to be a null guard; checking a dangling value does not make it valid. It follows
direct aliases for array-index reads/writes, function arguments, and control
conditions. Operands under `sizeof`, `_Alignof`, `typeof`, and `__typeof__` are
treated as unevaluated for these checks. It also reports
repeated free calls to the same tracked allocation, including a direct alias,
when there is no intervening reassignment.
Calls such as `free(p + 1)` and `free(&p[1])` (non-zero or non-constant
offsets) are reported as
`MEMORY|INVALID_FREE|` when the expression contains a tracked allocation
pointer and performs pointer arithmetic or indexing; these calls do not count
as releasing the allocation, so the outstanding allocation is still reported.
Simple casts around a base pointer, such as `free((void *)p)`, are normalized
to the same base-pointer release as `free(p)`.
An address-of expression for an untracked object, such as `free(&local)`, is
reported as `MEMORY|INVALID_FREE|...|free called with the address of a non-heap object`
and is not treated as a heap release.
Stack arrays such as `char buffer[32]; free(buffer);` are reported as
`MEMORY|INVALID_FREE|...|free called on a stack array`.
Direct aliases and short alias chains to such arrays, for example
`char *p = buffer; char *q = p; free(q);`, are reported as stack-array frees as well.
Derived forms such as `free(buffer + 1)` are also reported as invalid stack-pointer frees.
Simple non-pointer stack values such as `int value; free(value);` are reported
as `MEMORY|INVALID_FREE|...|free called on a non-pointer stack value`.
An uninitialized pointer such as `char *p; free(p);` is reported as
`MEMORY|INVALID_FREE|...|free called on an uninitialized pointer`.
Short pointer aliases of an uninitialized declaration are checked as well.
Pointers returned by `alloca`, `__builtin_alloca`, `strdupa`, or `strndupa` are reported as
`MEMORY|INVALID_FREE|...|free called on an alloca pointer`.
Passing those pointers to `realloc` or `reallocarray` is likewise reported as
`MEMORY|INVALID_REALLOC|...|realloc called on an alloca pointer`.
String and character literals passed directly to `free`, such as
`free("literal")` or `free('x')`, are reported as invalid frees as well.
Pointers initialized directly from a string literal and then passed to `free`
are reported as `...|free called on a pointer to a string literal`.
Short aliases of those pointers are followed for the same diagnostic.
Non-zero integer literals passed directly to `free`, such as `free(16)`, are
also reported as invalid frees; `free(0)` remains the standard safe null case.
Use-after-free checks also follow the released allocation identity: accessing its
original pointer after a recognized release helper frees a direct alias is
reported even though the helper received a different variable name.
Returning a released pointer from a function, such as `free(p); return p;`, is
reported as `MEMORY|USE_AFTER_FREE|...|released pointer returned from function`.
Using that value in pointer arithmetic, such as `free(p); p = p + 1;` or
`free(p); p = p + 0;`,
is reported as `MEMORY|USE_AFTER_FREE|...|released pointer used in pointer arithmetic`.
Casting the released value back into the same pointer, such as
`free(p); p = (void *)p;`, is also reported as
`MEMORY|USE_AFTER_FREE|...|released pointer used in a cast assignment`.
For allocations, simple non-null guards such as `if (p) free(p)` and
`if (p != NULL) free(p)` count as releasing the successful allocation path;
the opposite null-test arm does not.

Release functions are summarized within their defining file when a parameter is
passed directly to `free`, either unconditionally or in both arms of a top-level
`if/else`; calls to that parameter position are then treated as releases.
Passing a detected stack array to such a release helper is reported as an
invalid free instead of being treated as a valid ownership release.
The same applies to pointers initialized from string literals.
`alloca`-derived pointers passed to recognized release helpers are also reported
as invalid frees.
Conditional aliases are accepted only when used within the same branch context.
Direct alias bindings and alias chains are resolved against the nearest tracked
brace scope, so an inner declaration that shadows an alias does not replace the
outer alias after the block ends. This scope handling applies only to aliases
connected to tracked allocations; it is not a complete C symbol-table model.
Pointer reassignment after a release is also path-aware for UAF checks: a
reassignment in one arm clears the stale-pointer warning only within that arm;
both arms assigning the pointer can clear it after the branch. Exact self-
assignments or pointer expressions that read the same stale pointer (such as
`p = p` or `p = p + 0`) do not clear the freed-pointer state. Direct aliases
created from a freed pointer are also tracked for subsequent simple reads.
Alias-based UAF checks respect branch compatibility, so a release in one arm
does not taint a mutually exclusive opposite arm.

This is intentionally not a proof of leak-freedom. Releases inside loops are not
considered guaranteed, and the analyzer does not model struct-member ownership
or leaks (though simple `p->field` accesses after release are checked), general
pointer arithmetic or casts, function pointers, `goto`/`switch`, preprocessor
expansion, or release-function summaries across files. Complex C syntax can still
produce false positives or missed leaks. Tracked allocation bindings distinguish
nested brace scopes for direct frees, `realloc`, recognized same-file release
helpers, and direct returns. This is not full C lexical name resolution (for
example, shadowing declarations without a tracked allocation are not modeled
generally). Use a full C analyzer and runtime sanitizers for security- or
safety-critical code.

Use-after-free and double-free diagnostics are limited to simple pointer
expressions within the same top-level function scope. Direct alias chains are
tracked for array-index reads and repeated frees; unary dereference checks only
the direct variable. Calls to recognized same-file release helpers contribute
to release state and subsequent direct UAF/double-free checks. For repeated
frees, branch contexts are compared for path compatibility: mutually exclusive
`if/else` arms are not treated as repeated execution, while two frees that can
occur on the same path (including an unconditional free followed by a
conditional free) are reported. A recognized null-test arm such as
`if (!p) free(p)` is excluded because freeing a null pointer is safe. Repeated
frees in the same loop body/iteration are checked too. A single release site
inside a loop is also reported as a possible repeated free when the loop body
has no assignment to that pointer, `break`, or `return`. This deliberately
conservative check does not prove that the loop actually iterates more than
once; more complex loop conditions and control flow may still be missed.

Run the WebAssembly fixture tests after rebuilding:

```sh
node --test Tests/test_leak_detector.mjs
```

The supported directory-drop API fallbacks can be tested with:

```sh
node --test Tests/test_directory_drop.mjs
```
