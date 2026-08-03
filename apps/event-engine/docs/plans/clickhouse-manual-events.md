Okay, I'd like to go ahead and treat Outbox events:
src\handlers\outbox.ts

as an example and create a new type of handler pipeline, src/handlers/manual.ts following the same structure where there's essentially a processor that makes it really easy and a separate folder for handling them src/handlers/manual. I've created a new table in clickhouse, this:
```sql
CREATE TABLE IF NOT EXISTS kafka.manual_events
(
    date           DateTime,
    event          String,
    data           String
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = '24.144.71.35:9094',
    kafka_topic_list = 'clickhouse.manual_events',
    kafka_group_name = 'clickhouse-event-watcher',
    kafka_format = 'JSONEachRow',
    kafka_thread_per_consumer = 0,
    kafka_num_consumers = 1;
```

that allows anybody to post an event through ClickHouse to get it directly into this topic: 'clickhouse.manual_events'

As an demo, create src/handlers/manual/fetch-compensation.ts as the first implemented manual event handler, don't worry about having it do anything yet.

To confirm your understanding, please summarize your plan below and the structure of the handler factory.