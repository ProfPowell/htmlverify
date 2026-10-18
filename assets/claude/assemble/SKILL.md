---
name: htmlverify-assemble
description: Build a web page by assembling reviewed components with the htmlverify MCP tools (list_components, get_component, assemble) instead of writing its HTML by hand. Use whenever you create a page.
---

# Assembling pages with htmlverify

Here, pages are assembled, not hand-written. You write a plan: which components to use, the content each one shows, and what goes in their slots. The `assemble` tool renders it from components whose markup is reviewed once, checks the result, and writes the page when it passes. The choice of components and the content are yours; the markup is theirs.

## Workflow

1. Read the catalog with `list_components`. Each line is a component: its ID, what it's for, its data, and its slots. In the data, `?` marks an optional parameter, `=a|b` its choices, parentheses a type other than plain text or a list's fields, and `[min..max]` a count.
2. Look at each component you'll use with `get_component`: its parameters' types and limits, the components each slot takes, and an example node.
3. Write the plan to `plan.json`, indented two spaces a level so its brackets are easy to match, with the fewest components that express the content and its intent. A page starts from `page/basic`, or `page/article` for a blog post, news story, or press release; either writes the head, including Vanilla Breeze's stylesheet and script. Put the content in the data as given, in the parameters' types; only `inline` and `prose` parameters take markup, and only the elements they allow. Mark dates and times up there as `<time datetime="…">`.
4. Run `assemble` with `{ "path": "plan.json", "out": "page.html" }`. It writes `page.html` only when the page passes.
5. When it fails, act on each finding by its origin, in brackets after the message:
   - **plan**, or a finding located in `plan.json`: fix the plan at the JSON Pointer it names.
   - **composition**: those components don't fit where you put them; choose others, or another place.
   - **component**: the component itself is at fault. Don't work around it; tell the person in your reply.
   Then edit `plan.json` and assemble again.
6. Where no component fits, use an HTML node, `{ "key": "…", "html": "…" }`, with the least markup that does the job, and name the gap in your reply. Paragraphs, lists, and links go in `content/prose`, not in HTML nodes.
7. Stop after 3 failing assemblies, or when the same finding survives two rounds, and report what remains.

## Plans

```text
{ "page": { "use": "page/basic", "data": { "title": "…", "site": "…", "description": "…", "heading": "…" }, "slots": { "nav": [node], "main": [node, …], "footer": [node] } } }
```

A node is `{ "use": "<component ID>", "key": "<name>", "data": { … }, "slots": { "<slot>": [node, …] } }`. Every node but the page's root has a `key`: lowercase letters, digits, and hyphens, unique among its siblings. Keys become IDs, so a `ref` parameter names an instance by its key path, such as `{ "ref": "faq" }`, or `{ "ref": "help/faq" }` for one inside `help`. Headings take their level from where they sit, so you don't choose it.

## Rules of engagement

- Never write or edit `page.html` yourself; change the plan and assemble again.
- Never invent content to get a pass: no made-up alt text, labels, captions, or review answers.
- A warning that a component hasn't been approved is for the person who reviews components. Mention it, but don't avoid the component because of it.
- Review items are questions for the person. Pass them on; don't answer them yourself.
