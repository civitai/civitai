Okay, so I'd like you to carefully review the signals overview:
docs\reference\signals-overview.md

and then implement a new service similar to the Redis cache or metric event batcher for sending delta signals. Essentially, what we want to do is make it so that in the same way that when we're where we increment Redis as metrics are updated, we will send out signals to entity-specific topics with deltas of metrics. So as a metric type increases, we say, hey, `entity-metrics:{entityType}:{entityId}` `{[metricType]:+1}`.

to make it easier to work with the signal service backend. I think rather than doing direct API calls, it might make sense to add a signals service to the comments/services folder, then use that in the service you add to the src/services folder.