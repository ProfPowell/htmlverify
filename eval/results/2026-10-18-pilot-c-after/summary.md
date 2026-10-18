# Pilot: condition C on every brief, after the fixes

Briefs: 404, about, article, checkout-address, contact, data-report, docs, event, faq, home, legal, newsletter, press-release, pricing, product-detail, product-list, search-results, settings, sign-up, team. Driver: agent. Model: claude-sonnet-5-5. Scored with htmlverify's strict profile. C assembled with --draft, so unreviewed components only warned.

| Measure | Condition C |
| --- | --- |
| Runs | 20 |
| Pass on the first attempt | 18/20 (90%) |
| Pass at the end | 20/20 (100%) |
| Pass at the end, standard profile¹ | 20/20 (100%) |
| Median failing checks² | 0.0 |
| Runs that hit the cap of 3² | 0 |
| HTML nodes per page (registry gaps) | 0.3 |
| Errors by origin: plan, composition, component² | 18, 0, 0 |
| Pages written by hand | 0 |
| Tool calls refused | 16 |
| Errors per page | 0.0 |
| Errors per page, standard profile¹ | 0.0 |
| Checklist met | 91% |
| Structural variance | – |
| Output tokens | 2210 |
| Cost (USD) | $0.10 |
| Wall time (s) | 21 |

¹ Conformance without the house style: the standard profile, with the house boolean form (`required="true"`) noted rather than counted, since HTML itself allows only `""` or the attribute name.

² For C, failing checks are failing assemblies, from the MCP server's log; the cap is the third, after which the result says to stop. Origins total the errors of every assembly in every run, plan-stage ones included.

Per run:

| Brief | Condition | Run | First | Final | Standard | Failing checks | Gaps | Errors | Checklist |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 404 | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/4 |
| about | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/5 |
| article | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/5 |
| checkout-address | C | 1 | pass | pass | pass | 0 | 0 | 0 | 7/7 |
| contact | C | 1 | pass | pass | pass | 0 | 0 | 0 | 7/7 |
| data-report | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/5 |
| docs | C | 1 | fail | pass | pass | 2 | 0 | 0 | 5/5 |
| event | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/6 |
| faq | C | 1 | pass | pass | pass | 0 | 0 | 0 | 3/3 |
| home | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/6 |
| legal | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/4 |
| newsletter | C | 1 | pass | pass | pass | 0 | 0 | 0 | 6/6 |
| press-release | C | 1 | pass | pass | pass | 0 | 0 | 0 | 4/5 |
| pricing | C | 1 | fail | pass | pass | 2 | 3 | 0 | 5/5 |
| product-detail | C | 1 | pass | pass | pass | 0 | 1 | 0 | 6/7 |
| product-list | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/6 |
| search-results | C | 1 | pass | pass | pass | 0 | 0 | 0 | 5/5 |
| settings | C | 1 | pass | pass | pass | 0 | 2 | 0 | 5/6 |
| sign-up | C | 1 | pass | pass | pass | 0 | 0 | 0 | 7/7 |
| team | C | 1 | pass | pass | pass | 0 | 0 | 0 | 3/4 |
