# page/basic

A page: head with Vanilla Breeze, skip link, site header, main with the page heading, and an optional footer.

Every page that isn't an article starts here. It links Vanilla Breeze 0.3.1 from unpkg (stylesheet and module script, plus the icon path), sets the language, and gives the page one h1. The title reads "Title | Site", or just the site name when the title is left out, as on the home page.

The skip link is the first focusable element; Vanilla Breeze doesn't ship its CSS, so the page carries the few rules it needs. The header holds the home link and, in nav, the site navigation, which comes before the h1 and so takes nav/primary only. Use site/footer in footer.
