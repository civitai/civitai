- [x] Setup Outbox
  - [x] Table
  - [x] Consumer (so we clean-up)
  - [x] Triggers
  - [x] Add outbox handlers
    - [x] User.uploadCount (from modelVersion publish)
    - [x] Feed Updates
      - [x] Image (publish/unpublish, post order change)
      - [x] Model (publish/unpublish)
        - [x] ModelVersion (publish/unpublish)
      - [x] Post (publish)
- [x] Setup Clickhouse Ingest
  - [x] Kafka Engine
  - [x] Topic listeners
  - [x] Add clickhouse handlers
    - [x] modelVersionEvent (Model.downloadCount, ModelVersion.downloadCount)
    - [x] orchestration.jobs (Model.generationCount, ModelVersion.generationCount)
    - [x] buzz_resource_compensation (Model.earnedAmount, modelVersion.earnedAmount)
  - [x] Add daily rollup metrics mat view
- [x] Setup additional handlers for other meili feeds
  - [x] Bounties - queue index
  - [x] Articles - queue index
  - [x] Tags
    - [x] TagsOnPost - queue index
    - [x] TagsOnModels - queue index
    - [x] TagsOnImageNew - queue index
    - [x] TagsOnBounty - queue index
- [x] Setup Metric Update processing
  - [x] Egress to Clickhouse (Queue/Batch)
  - [x] Increment Redis
- [x] Setup Redis Metric Updating
- [x] Integrate Signals Service
  - [x] add call to redis service
- [ ] Feed Update processing
- [ ] Common Package
  - [x] Metric
    - [x] Types
    - [x] Query System
    - [x] Cache Interactions
  - [x] Outbox communication
    - [x] Event Types
    - [x] Event Creation - PG writes/deletes
  - [ ] Meilisearch
    - [ ] Index Types
    - [ ] Index Syncing
      - [ ] CreateOrUpdate
      - [ ] Delete
- [ ] React useMetricState

```
function useMetricState() {
    // listen to topic
    // metricState = wrap metrics + listenerCount with state
    // handle messages
        // if metric key
            // inc by deltas
        // if listener notification
            // inc listenerCount
    return metricState
}

const metrics = useMetricState<MetricType = Record<string,number>>({
    metrics: MetricType,
    topic: `metrics:{entityType}:{entityId}`,
})

return <p>{metric.reactionCount}</p>
```