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
`malloc`, `calloc`, `realloc`, `reallocf`, `reallocarray`, `recallocarray`,
`aligned_alloc`, `strdup`, `strndup`, `memdup`, `memdup2`, `memalign`, `valloc`, `pvalloc`, and
`posix_memalign`; `free(pointer)`, a direct
`return pointer`/alias or simple member expression, and recognized
release-function calls can dispose of a candidate. A return transfers ownership
only when the returned expression is exactly the tracked pointer or a direct
alias; merely mentioning it in a conditional or pointer-arithmetic expression
does not suppress a leak. Return/release branches suppress a finding only when
all represented paths transfer or release ownership. Direct aliases and alias
chains (such as `q = p; r = q; free(r);`) are followed. An `if/else` suppresses
a finding only when both arms release or transfer the candidate; an allocation
and release within the same branch is also understood. `switch` cases are
checked similarly: a release in only some cases produces a possible leak,
while explicit `break` boundaries and simple fallthrough to a later release
are recognized.
The C23 `free_sized` and `free_aligned_sized` deallocators, plus the BSD-style
`cfree` and `freezero` helpers, are treated like `free`, including alias,
double-free, and stack-object checks.
Simple member chains such as `object->field = malloc(...)`,
`object.field = malloc(...)`, and `object->inner.buffer = malloc(...)` are
tracked independently by their owning object; direct `free` and recognized
release-helper calls on the same member release the matching allocation, and
later reads through that released member are reported as use-after-free until
the member is assigned a new allocation.
The same expression matching is used for `realloc`: an unchecked
`object->field = realloc(object->field, size)` reports `REALLOC_LOSS`, while
using a released member as the `realloc` input reports use-after-free.
It reports a pointer overwritten by another allocation before a proven release.
`reallocarray` is analyzed with the same move/failure ownership rules as
`realloc`. BSD `recallocarray` is analyzed with the same rules, using its
new-element-count and element-size arguments for constant-size checks. It warns
when a direct `p = realloc(p, size)` assignment can lose
the original pointer on allocation failure; a temporary-pointer realloc pattern is not
reported by this specific heuristic. Passing a directly tracked freed pointer
or one of its direct aliases to `realloc` is reported as a use-after-free
candidate. A temporary realloc result guarded by a simple non-null `if (tmp)`
is modeled as existing only on the success arm; the original pointer remains
owned on the failure arm, so both paths must release or transfer their owner.
`reallocf` is modeled separately: its failure path releases the original
pointer, so direct self-assignment does not produce `REALLOC_LOSS`.
An ignored standalone `realloc(p, size);` result is also reported because the
successful result may move while the old pointer becomes invalid. Repeated
`free(NULL)` and `free(0)` are not treated as double frees.
For constant positive factors, `calloc`, `reallocarray`, and `recallocarray` report
`MEMORY|ALLOCATION_SIZE_OVERFLOW|...` when the element-count multiplication
exceeds the analyzer's 32-bit `size_t` target range. The same check covers
constant multiplicative size expressions in `malloc`, `realloc`, and
`aligned_alloc`, such as `malloc(count * 64)` when both factors are literals.
Dynamic factors and architectures with a wider `size_t` remain unknown rather
than being guessed.
If another alias still points at the allocation when `realloc` is called, later
reads, calls, control-condition checks, or releases through that old alias are
reported as `MEMORY|USE_AFTER_REALLOC|...|alias may be invalid after realloc`.
Reassigning the alias after the reallocation suppresses that stale-alias report.
Results from `malloc`, `calloc`, `realloc`, `reallocf`, `reallocarray`, `recallocarray`, `aligned_alloc`,
`strdup`, `strndup`, `memdup`, `memdup2`, `memalign`, `valloc`, `pvalloc`, and `posix_memalign` are treated as
potentially NULL: indexing,
dereferencing, pointer-arithmetic dereferencing, and `->` access without a
simple non-null guard produce
`MEMORY|MAYBE_NULL_DEREFERENCE|...`. A direct `if (p)` guard suppresses the
diagnostic on its non-null arm; freeing the result does not produce it.
Passing a detected stack array to `realloc`, `reallocf`, `reallocarray`, or
`recallocarray` is reported as
`MEMORY|INVALID_REALLOC|...|realloc called on a stack array`.
Direct aliases of stack arrays are followed for this check as well.
The check also applies when the reallocation result is assigned to another
pointer variable, including when the input is a direct alias of the stack array.
Non-zero pointer arithmetic, non-zero indexing, and address-of expressions passed
as the `realloc`/`reallocf`/`reallocarray`/`recallocarray` input are reported as
`...|realloc called with a derived pointer instead of the allocation base`;
zero-offset forms such as `realloc(p + 0, size)` are normalized as the base.
The same diagnostic class reports simple non-pointer stack values passed to
these functions as `...|realloc called on a non-pointer stack value`.
Pointers initialized from string literals are likewise rejected by
`realloc`, `reallocf`, `reallocarray`, and `recallocarray`.
Uninitialized pointer arguments are rejected in both direct and result-assignment
forms as `...|realloc called on an uninitialized pointer`.
It also flags simple same-scope array-index, unary-dereference, function-
argument, and control-condition reads after `free(p)`, including pointers
embedded in parenthesized argument expressions such as `consume(1 + (p + 1))`.
The same contexts are checked for pointers declared without an initializer;
for example, `char *p; p[0]`, `*p`, `use(p)`, and `if (p)` produce
`MEMORY|UNINITIALIZED_POINTER_USE|...` diagnostics. Short aliases of an
uninitialized pointer are followed for these reads too.
This includes `p->field` member access.
Pointers proven to contain `NULL` or `0` are reported as
`MEMORY|NULL_DEREFERENCE|...` when indexed, dereferenced, or used with `->`.
The same diagnostic is emitted in a branch proven by `if (!p)`, `if (p == NULL)`,
or the equivalent zero comparison; the non-null arm of `if (p)` is not reported.
Short aliases and later assignments are resolved conservatively, so assigning a
new allocation before the access clears the known-null state.
For fixed-size stack arrays, constant indexes outside the known range, such as
`char buffer[8]; buffer[8]` or `buffer[-1]`, produce
`MEMORY|OUT_OF_BOUNDS|...` diagnostics. Constant indexes through a short alias
are checked as well. Constant-size `malloc`, `calloc`, `realloc`,
`reallocarray`, `recallocarray`, `aligned_alloc`, and `strndup` results are bounded too, including
short aliases; dynamic allocation sizes remain unknown rather than being guessed.
The same check covers constant pointer arithmetic when it is immediately
dereferenced, such as `*(buffer + 8)` or `*(buffer - 1)`; merely forming a
one-past pointer without dereferencing it is not reported.
The same bound check covers constant byte counts passed to the destination of
`memcpy`, `memmove`, `memset`, and `strncpy`, and to the source of
`memcpy`/`memmove`, including known-size heap allocations;
an unknown byte count is left unclassified.
Constant destination and source offsets such as
`memcpy(buffer + 4, source + 2, 8)` are combined with the byte count before
checking the known bound.
The same known stack/heap bounds are applied to the buffer argument of
`read`, `recv`, `recvfrom`, `write`, `send`, and `sendto`; constant violations
produce `MEMORY|OUT_OF_BOUNDS|...`, while dynamic byte counts remain unknown.
Known-null I/O buffers with a non-zero or dynamic byte count produce
`MEMORY|NULL_ARGUMENT|...`; zero-byte operations are excluded.
Allocation results used as memory/string destinations or sources, or as I/O
buffers, produce `MEMORY|MAYBE_NULL_ARGUMENT|...` when the call is not inside a
simple non-null guard. The check covers direct aliases of `malloc`, `calloc`,
`realloc`, `reallocarray`, `aligned_alloc`, `strdup`, `strndup`, `memalign`,
`valloc`, `pvalloc`, and `posix_memalign` results;
zero-byte operations and the non-null arm of `if (p)` are excluded.
The common `posix_memalign(&p, alignment, size)` and
`posix_memalign((void **)&p, alignment, size)` forms are also tracked as
out-parameter allocations; because the return code is not yet modeled, callers
should still check the result before using `p`.
Simple early-exit guards such as `if (!p) return;`, `if (p == NULL) return;`,
or `if (!p) abort();` also establish non-nullness for subsequent uses. An
`else` arm whose first statement is a recognized terminating call is handled in
the same way. Ordinary logging or helper calls remain conservative.
`memcpy` is also reported as `MEMORY|OVERLAPPING_COPY|...` when its source and
destination resolve to the same allocation through a direct expression or a
short alias; `memmove` is intentionally allowed. This is a conservative
same-allocation check, not a complete interval-overlap proof.
`gets(buffer)` on a known stack array is reported as
`MEMORY|UNSAFE_INPUT|...`, while a constant `fgets(buffer, n, ...)` size larger
than the remaining array capacity is reported as `MEMORY|OUT_OF_BOUNDS|...`;
constant destination offsets are included in that calculation.
Unbounded `strcpy`, `strcat`, `sprintf`, and `vsprintf` calls into a known stack
array are reported as `MEMORY|UNSAFE_COPY|...`; heap destinations are not inferred
to be bounded by this check. `strncat` is also reported for a known stack
destination when its count is non-zero or dynamic, because the remaining space
after the existing string is not known. A zero count is exempt.
Constant `snprintf` and `vsnprintf` sizes larger than the remaining known stack
array capacity are reported as `MEMORY|OUT_OF_BOUNDS|...`; dynamic sizes remain
unknown.
Known-null pointers passed as writable destinations or readable sources to these
memory/string APIs are reported as `MEMORY|NULL_ARGUMENT|...`; zero-length
constant operations are excluded, and a null-test branch is respected.
Returning a known stack array, the address of a local scalar, or an `alloca`
pointer is reported as `MEMORY|STACK_ESCAPE|...` because the storage expires when
the function returns. Aliases that carry an inner-block stack array into a
`return` are included as well. The same diagnostic is emitted when an outer pointer keeps
an alias to an inner-block stack array and is used after that block ends. Heap-
pointer returns and uses before the inner block ends remain valid ownership/use
patterns. A simple struct member assigned from a stack array is also tracked
when that member is returned, until it is reassigned. Assigning a stack array
or one of its tracked aliases to a file-scope pointer or simple global struct
member reports the same `MEMORY|STACK_ESCAPE|...` category; a local shadow with
the same name is kept separate. Within a dropped file, a direct pointer-parameter
return such as `identity(pointer)`, including a short local alias returned by
that helper, is also followed at the call site. Non-static
summaries are collected across dropped files, so passing a stack array to that
function reports the same escape category while passing a heap pointer does not;
file-local `static` definitions remain isolated. The same cross-file summaries
also cover helpers that store a pointer parameter in global storage, reporting
the escape at the caller while heap arguments remain allowed. A short local
alias chain inside that helper is followed too, while an alias overwritten with
a non-pointer value is no longer treated as carrying the escaped pointer.
Assignments such as `*out = local` and `*out = &value` in a pointer-to-pointer
parameter are also reported as stack escapes; short local aliases on the right
hand side are followed. Direct heap assignments such as `*out = malloc(...)`
are propagated to the caller as output-parameter ownership, so a later
`free(pointer)` is matched and a missing release is reported. This ownership
summary is emitted only when the write or allocator assignment occurs on every
represented top-level branch; a one-sided conditional write remains an
uncertain output and does not suppress an uninitialized-pointer warning.
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
Passing those pointers to `realloc`, `reallocarray`, or `recallocarray` is likewise reported as
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

Release functions are summarized when a parameter is passed directly to `free`,
or through a short local pointer alias, either unconditionally or in both arms
of a top-level `if/else`; calls to that parameter position are then treated as
releases. Alias summaries cover unconditional helper bodies or represented
top-level `if/else` arms; the same branch-coverage rules are used to avoid
treating one-sided conditional frees as unconditional. Non-`static` release helpers
are collected across all dropped files before the second analysis pass, so a
caller can appear before its helper and still be modeled. File-local `static`
helpers remain limited to their defining file.
Unconditional wrapper helpers are followed transitively, including when the
wrapper and its underlying helper are in different dropped files; summary
collection repeats to a bounded fixed point so file order does not matter.
Helpers that receive a `struct` pointer and directly free a member path,
such as `free(holder->buffer)` or `free(holder->inner.buffer)`, are also summarized. A caller passing
`&holder` or a pointer such as `holder_ptr` then releases the matching member
allocation, including across dropped files. A short local alias such as
`char *buffer = holder->buffer; free(buffer);` is followed too; the same
release state feeds double-free and use-after-free checks. If the member is a
declared fixed-size array, the helper call is instead reported as an invalid
free.
The same declaration-aware check also covers direct `free(holder.buffer)` and
`free(holder_ptr->buffer)` calls.
Passing a detected stack array to such a release helper is reported as an
invalid free instead of being treated as a valid ownership release.
This also covers a simple struct member that currently holds a stack array,
including direct `free(h.buffer)` / `free(h->buffer)` calls and recognized
release-helper calls on that member. A local pointer alias copied from that
member, or copied back into that member, is tracked for the same stack-escape
and invalid-free checks.
Passing a non-zero derived pointer such as `release(p + 1)` to a recognized
release helper is likewise reported as an invalid free and does not release the
allocation; zero-offset forms such as `release(p + 0)` remain valid base-pointer
releases.
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
considered guaranteed, and the analyzer does not model complex nested-member
ownership such as array-indexed or dynamically selected member paths (though
simple member chains after release are checked), general
pointer arithmetic or casts, function pointers, general `goto` control flow, or
preprocessor expansion. Complex or indirect heap ownership through
pointer-to-pointer output parameters or dynamically selected destinations is
not inferred; direct `*out = allocator(...)` forms and exact
`*out = realloc(*out, size)`/`reallocarray`/`recallocarray` forms,
the dedicated `posix_memalign` out-parameter form, and the common standard-library
writers `getline`, `getdelim`, `asprintf`, and `vasprintf` are supported. Output
reallocation summaries are emitted only when the reallocation occurs on every
represented top-level branch. Those
standard-library writers are modeled as potentially-NULL ownership-producing
calls at argument zero; existing ownership replacement and failure details are
not simulated. Simple cleanup-label paths and `switch` case coverage
are handled by the heuristics below. Complex C syntax can still
produce false positives or missed leaks. Tracked allocation bindings distinguish
nested brace scopes for direct frees, `realloc`, recognized release helpers, and
direct returns. This is not full C lexical name resolution (for
example, shadowing declarations without a tracked allocation are not modeled
generally). Use a full C analyzer and runtime sanitizers for security- or
safety-critical code.

Use-after-free and double-free diagnostics are limited to simple pointer
expressions within the same top-level function scope. Direct alias chains are
tracked for array-index reads and repeated frees; unary dereference checks only
the direct variable. Calls to recognized release helpers contribute
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
The common cleanup form where one path jumps to a label, another path frees and
returns before that label, and the label frees the same pointer is recognized as
mutually exclusive. A conditional jump to a cleanup label combined with a return
before that label is reported when the return path does not release or directly
transfer the pointer. A label reached by ordinary fallthrough is still checked as
a possible second free; general `goto` control flow is not modeled. Simple
`case`/`default` arms that contain a `break` before the next case are likewise
treated as mutually exclusive for repeated-free checks; fallthrough cases remain
potential repeated frees.

Run the WebAssembly fixture tests after rebuilding:

```sh
node --test Tests/test_leak_detector.mjs
```

The supported directory-drop API fallbacks can be tested with:

```sh
node --test Tests/test_directory_drop.mjs
```
