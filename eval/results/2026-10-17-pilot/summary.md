# Pilot: conditions A and B, 5 briefs × 2 runs

Briefs: article, contact, data-report, faq, product-detail. Driver: agent. Model: claude-sonnet-5-5. Scored with htmlverify's strict profile.

| Measure | Condition A | Condition B |
| --- | --- | --- |
| Runs | 10 | 10 |
| Pass on the first attempt | 0/10 (0%) | 3/10 (30%) |
| Pass at the end | 0/10 (0%) | 10/10 (100%) |
| Pass at the end, standard profile¹ | 10/10 (100%) | 10/10 (100%) |
| Median failing checks | 0.0 | 1.0 |
| Runs that hit the cap of 3 | 0 | 1 |
| Errors per page | 7.1 | 0.0 |
| … component | 1.3 | 0.0 |
| … policy | 1.1 | 0.0 |
| … semantic | 0.8 | 0.0 |
| … style | 3.9 | 0.0 |
| Errors per page, standard profile¹ | 0.0 | 0.0 |
| Checklist met | 95% | 97% |
| Structural variance | 0.25 | 0.13 |
| Output tokens | 1877 | 2652 |
| Cost (USD) | $0.08 | $0.14 |
| Wall time (s) | 18 | 27 |

¹ Conformance without the house style: the standard profile, with the house boolean form (`required="true"`) noted rather than counted, since HTML itself allows only `""` or the attribute name.

Per run:

| Brief | Condition | Run | First | Final | Standard | Failing checks | Errors | Checklist |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| article | A | 1 | fail | fail | pass | 0 | style 1, semantic 2 | 5/5 |
| article | A | 2 | fail | fail | pass | 0 | style 2 | 5/5 |
| article | B | 1 | fail | pass | pass | 1 | 0 | 5/5 |
| article | B | 2 | fail | pass | pass | 1 | 0 | 5/5 |
| contact | A | 1 | fail | fail | pass | 0 | style 4, policy 7 | 7/7 |
| contact | A | 2 | fail | fail | pass | 0 | style 12 | 7/7 |
| contact | B | 1 | fail | pass (capped) | pass | 7 | 0 | 7/7 |
| contact | B | 2 | fail | pass | pass | 1 | 0 | 7/7 |
| data-report | A | 1 | fail | fail | pass | 0 | style 2, policy 1 | 5/5 |
| data-report | A | 2 | fail | fail | pass | 0 | style 2 | 5/5 |
| data-report | B | 1 | fail | pass | pass | 1 | 0 | 5/5 |
| data-report | B | 2 | pass | pass | pass | 0 | 0 | 5/5 |
| faq | A | 1 | fail | fail | pass | 0 | style 4, component 13 | 2/3 |
| faq | A | 2 | fail | fail | pass | 0 | style 2 | 3/3 |
| faq | B | 1 | pass | pass | pass | 0 | 0 | 3/3 |
| faq | B | 2 | pass | pass | pass | 1 | 0 | 3/3 |
| product-detail | A | 1 | fail | fail | pass | 0 | style 5, semantic 3, policy 2 | 6/7 |
| product-detail | A | 2 | fail | fail | pass | 0 | style 5, semantic 3, policy 1 | 7/7 |
| product-detail | B | 1 | fail | pass | pass | 1 | 0 | 6/7 |
| product-detail | B | 2 | fail | pass | pass | 1 | 0 | 6/7 |
