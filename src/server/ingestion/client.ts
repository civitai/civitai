import { AMQPChannel, AMQPClient } from "@cloudamqp/amqp-client";
import { env } from "~/env/server.mjs";
import type { AMQPBaseClient } from "@cloudamqp/amqp-client/types/amqp-base-client";
import { ingestionMessageSchema } from "../utils/image-ingestion";

export const amqp = new AMQPClient(
  env.IMAGE_INGESTION_MESSAGE_QUEUE_SERVER ?? "amqp://localhost"
);

let connection: AMQPBaseClient | undefined = undefined;

export const tryConnect = async () => {
  if (connection) {
    return connection;
  }
  return amqp
    .connect()
    .then((conn) => {
      connection = conn;
      return conn;
    })
    .catch((err) => {
      connection = undefined;
      throw err;
    });
};

export const tryDefaultChannel = () =>
  tryConnect().then((conn) => getDefaultChannel(conn));

export const getDefaultChannel = (conn?: AMQPBaseClient) =>
  conn ? conn.channel() : connection?.channel();

export const isConnected = () =>
  connection === undefined ? false : connection.closed === false;

/**
 * Pass a basic message to a topic
 * const channel = await tryDefaultChannel();
 * await tryBasicPublish(channel, "ingestion", { source: {}, ... }));
 */
export const tryBasicPublish = async <T extends typeof ingestionMessageSchema>(
  channel: AMQPChannel,
  topic: string,
  message: T
): Promise<number> => {
  return channel.basicPublish("amq.topic", topic, JSON.stringify(message), {
    contentType: "application/json",
  });
};

// Very special name for the reply-to mechanics to work
// https://www.rabbitmq.com/direct-reply-to.html
const REPLY_QUEUE = "amq.rabbitmq.reply-to";

// Queue name for the RPC messages on the workers
const SERVER_QUEUE = "rpc.server.queue";

/**
 * Send a message and get a response from the image ingestion.
 *
 * @param message - message to send in the request to the image ingestion worker.
 * @param id - semi-unique id to validate the message correlation
 * @param responseSchema - validate the response message into this schema
 * @returns Promise<typeof responseSchema> - Returns the response or rejects with errors
 *
 * Example:
 *
 * ```javascript
 * tryRPC({ source: { ... }, ...}, "id-19284", ingestionMessageSchema).then(resp => {
 *   console.log("Response: ", resp);
 * }).catch(err => console.error(error));
 * ```
 */
export const tryRPC = async (
  message: unknown,
  id: string,
  // TODO: hard coded image ingestion here
  responseSchema: typeof ingestionMessageSchema
) => {
  return new Promise(async (resolve, reject) => {
    const ch = await tryDefaultChannel();
    if (ch === undefined) {
      reject("Could not create a default channel");
      return;
    }

    const consumer = await ch.basicConsume(
      REPLY_QUEUE,
      { noAck: true },
      async (msg) => {
        const body = msg.bodyToString();
        if (body === null) {
          reject("Could not parse body to string");
          return;
        }

        if (msg.properties.correlationId !== id) {
          reject(
            `Could not validate the correlationId., ${msg.properties.correlationId}, ${id}`
          );
          return;
        }

        const validation = await responseSchema.safeParseAsync(msg);

        if (validation.success) {
          resolve(validation.data);
        } else {
          reject("Failed to validate response message. Code: 01");
        }

        await consumer.cancel();
      }
    );

    await ch.basicPublish(
      "",
      SERVER_QUEUE,
      JSON.stringify(message),
      {
        contentType: "application/json",
        replyTo: REPLY_QUEUE,
        correlationId: id,
      },
      true
    );

    await consumer.wait();
  });
};
