# Pilot: A, B, and C on every brief

Briefs: 404, about, article, checkout-address, contact, data-report, docs, event, faq, home, legal, newsletter, press-release, pricing, product-detail, product-list, search-results, settings, sign-up, team. Driver: agent. Model: claude-sonnet-5-5. Scored with htmlverify's strict profile. C assembled with --draft, so unreviewed components only warned.

| Measure | Condition A | Condition B | Condition C |
| --- | --- | --- | --- |
| Runs | 20 | 20 | 20 |
| Pass on the first attempt | 0/20 (0%) | 0/20 (0%) | 20/20 (100%) |
| Pass at the end | 0/20 (0%) | 20/20 (100%) | 20/20 (100%) |
| Pass at the end, standard profile¹ | 19/20 (95%) | 20/20 (100%) | 20/20 (100%) |
| Median failing checks² | 0.0 | 1.0 | 0.0 |
| Runs that hit the cap of 3² | 0 | 0 | 0 |
| HTML nodes per page (registry gaps) | – | – | 0.3 |
| Errors by origin: plan, composition, component² | – | – | 0, 0, 0 |
| Pages written by hand | – | – | 0 |
| Tool calls refused | 30 | 25 | 5 |
| Errors per page | 9.9 | 0.0 | 0.0 |
| … component | 1.1 | 0.0 | 0.0 |
| … content | 0.1 | 0.0 | 0.0 |
| … style | 8.8 | 0.0 | 0.0 |
| Errors per page, standard profile¹ | 0.1 | 0.0 | 0.0 |
| Checklist met | 96% | 99% | 94% |
| Structural variance | – | – | – |
| Output tokens | 1811 | 1893 | 1940 |
| Cost (USD) | $0.10 | $0.10 | $0.09 |
| Wall time (s) | 17 | 21 | 19 |

¹ Conformance without the house style: the standard profile, with the house boolean form (`required="true"`) noted rather than counted, since HTML itself allows only `""` or the attribute name.

² For C, failing checks are failing assemblies, from the MCP server's log; the cap is the third, after which the result says to stop. Origins total the errors of every assembly in every run, plan-stage ones included.

Per run:

| Brief | Condition | Run | First | Final | Standard | Failing checks | Gaps | Errors | Checklist |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 404 | A | 1 | fail | fail | pass | 0 | – | style 5 | 4/4 |
| 404 | B | 1 | fail | pass | pass | 1 | – | 0 | 4/4 |
| 404 | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/4 |
| about | A | 1 | fail | fail | pass | 0 | – | style 4 | 4/5 |
| about | B | 1 | fail | pass | pass | 1 | – | 0 | 4/5 |
| about | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/5 |
| article | A | 1 | fail | fail | pass | 0 | – | style 5 | 5/5 |
| article | B | 1 | fail | pass | pass | 1 | – | 0 | 5/5 |
| article | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/5 |
| checkout-address | A | 1 | fail | fail | pass | 0 | – | style 25 | 7/7 |
| checkout-address | B | 1 | fail | pass | pass | 1 | – | 0 | 7/7 |
| checkout-address | C | 1 | pass | pass | pass | 0 | 0 | 0 | 7/7 |
| contact | A | 1 | fail | fail | pass | 0 | – | style 10 | 7/7 |
| contact | B | 1 | fail | pass | pass | 1 | – | 0 | 7/7 |
| contact | C | 1 | pass | pass | pass | 0 | 0 | 0 | 7/7 |
| data-report | A | 1 | fail | fail | pass | 0 | – | style 4 | 5/5 |
| data-report | B | 1 | fail | pass | pass | 1 | – | 0 | 5/5 |
| data-report | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/5 |
| docs | A | 1 | fail | fail | fail | 0 | – | style 4, content 1 | 5/5 |
| docs | B | 1 | fail | pass | pass | 1 | – | 0 | 5/5 |
| docs | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/5 |
| event | A | 1 | fail | fail | pass | 0 | – | style 9 | 5/6 |
| event | B | 1 | fail | pass | pass | 1 | – | 0 | 6/6 |
| event | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/6 |
| faq | A | 1 | fail | fail | pass | 0 | – | style 3, component 13 | 2/3 |
| faq | B | 1 | fail | pass | pass | 1 | – | 0 | 3/3 |
| faq | C | 1 | pass | pass | pass | 0 | 0 | 0 | 3/3 |
| home | A | 1 | fail | fail | pass | 0 | – | style 10 | 6/6 |
| home | B | 1 | fail | pass | pass | 1 | – | 0 | 6/6 |
| home | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/6 |
| legal | A | 1 | fail | fail | pass | 0 | – | style 3 | 4/4 |
| legal | B | 1 | fail | pass | pass | 1 | – | 0 | 4/4 |
| legal | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/4 |
| newsletter | A | 1 | fail | fail | pass | 0 | – | style 6 | 6/6 |
| newsletter | B | 1 | fail | pass | pass | 1 | – | 0 | 6/6 |
| newsletter | C | 1 | pass | pass | pass | 0 | 0 | 0 | 6/6 |
| press-release | A | 1 | fail | fail | pass | 0 | – | style 3 | 5/5 |
| press-release | B | 1 | fail | pass | pass | 1 | – | 0 | 5/5 |
| press-release | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/5 |
| pricing | A | 1 | fail | fail | pass | 0 | – | style 4 | 5/5 |
| pricing | B | 1 | fail | pass | pass | 1 | – | 0 | 5/5 |
| pricing | C | 1 | pass | pass | pass | 0 | 3 | 0 | 5/5 |
| product-detail | A | 1 | fail | fail | pass | 0 | – | style 16 | 7/7 |
| product-detail | B | 1 | fail | pass | pass | 1 | – | 0 | 7/7 |
| product-detail | C | 1 | pass | pass | pass | 0 | 1 | 0 | 6/7 |
| product-list | A | 1 | fail | fail | pass | 0 | – | style 19, component 8 | 6/6 |
| product-list | B | 1 | fail | pass | pass | 3 | – | 0 | 6/6 |
| product-list | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/6 |
| search-results | A | 1 | fail | fail | pass | 0 | – | style 4 | 5/5 |
| search-results | B | 1 | fail | pass | pass | 1 | – | 0 | 5/5 |
| search-results | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/5 |
| settings | A | 1 | fail | fail | pass | 0 | – | style 15 | 6/6 |
| settings | B | 1 | fail | pass | pass | 1 | – | 0 | 6/6 |
| settings | C | 1 | pass | pass | pass | 0 | 2 | 0 | 6/6 |
| sign-up | A | 1 | fail | fail | pass | 0 | – | style 18 | 7/7 |
| sign-up | B | 1 | fail | pass | pass | 1 | – | 0 | 7/7 |
| sign-up | C | 1 | pass | pass | pass | 0 | 0 | 0 | 7/7 |
| team | A | 1 | fail | fail | pass | 0 | – | style 9 | 4/4 |
| team | B | 1 | fail | pass | pass | 1 | – | 0 | 4/4 |
| team | C | 1 | pass | pass | pass | 0 | 0 | 0 | 3/4 |
