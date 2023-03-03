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
