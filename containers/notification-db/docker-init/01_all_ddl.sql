--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE TYPE public."NotificationCategory" AS ENUM (
    'Comment',
    'Update',
    'Milestone',
    'Bounty',
    'Buzz',
    'Creator',
    'System',
    'Other'
);

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public."Notification" (
    id integer NOT NULL,
    type text NOT NULL,
    key text NOT NULL,
    category public."NotificationCategory" DEFAULT 'Other'::public."NotificationCategory" NOT NULL,
    details jsonb NOT NULL
);

CREATE SEQUENCE public."Notification_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public."Notification_id_seq" OWNED BY public."Notification".id;


CREATE TABLE public."PendingNotification" (
    id integer NOT NULL,
    type text NOT NULL,
    key text NOT NULL,
    users integer[] NOT NULL,
    details jsonb NOT NULL,
    "claimedAt" timestamp(3) without time zone,
    category public."NotificationCategory" DEFAULT 'Other'::public."NotificationCategory" NOT NULL,
    "debounceSeconds" integer,
    "lastTriggered" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "nextSendAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public."PendingNotification_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."PendingNotification_id_seq" OWNED BY public."PendingNotification".id;


CREATE TABLE public."UserNotification" (
    id integer NOT NULL,
    "notificationId" integer NOT NULL,
    "userId" integer NOT NULL,
    viewed boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public."UserNotification_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."UserNotification_id_seq" OWNED BY public."UserNotification".id;


ALTER TABLE ONLY public."Notification" ALTER COLUMN id SET DEFAULT nextval('public."Notification_id_seq"'::regclass);
ALTER TABLE ONLY public."PendingNotification" ALTER COLUMN id SET DEFAULT nextval('public."PendingNotification_id_seq"'::regclass);
ALTER TABLE ONLY public."UserNotification" ALTER COLUMN id SET DEFAULT nextval('public."UserNotification_id_seq"'::regclass);

ALTER TABLE ONLY public."Notification"
    ADD CONSTRAINT "Notification_key_key" UNIQUE (key);

ALTER TABLE ONLY public."Notification"
    ADD CONSTRAINT "Notification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."PendingNotification"
    ADD CONSTRAINT "PendingNotification_key_key" UNIQUE (key);

ALTER TABLE ONLY public."PendingNotification"
    ADD CONSTRAINT "PendingNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."UserNotification"
    ADD CONSTRAINT "UserNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."UserNotification"
    ADD CONSTRAINT "UserNotification_uniq_notif_user_id" UNIQUE ("notificationId", "userId");


CREATE INDEX "PendingNotification_claimedAt_idx" ON public."PendingNotification" USING btree ("claimedAt");

CREATE INDEX "PendingNotification_debounceSeconds_idx" ON public."PendingNotification" USING btree ("debounceSeconds");

CREATE INDEX "PendingNotification_nextSendAt_idx" ON public."PendingNotification" USING btree ("nextSendAt");

CREATE INDEX "UserNotification_createdAt_idx" ON public."UserNotification" USING btree ("createdAt");

CREATE INDEX "UserNotification_userId_idx" ON public."UserNotification" USING btree ("userId");

CREATE INDEX "UserNotification_userId_viewed_createdAt_idx" ON public."UserNotification" USING btree ("userId", viewed, "createdAt") WHERE (viewed IS FALSE);

CREATE INDEX "UserNotification_viewed_idx" ON public."UserNotification" USING btree (viewed);


ALTER TABLE ONLY public."UserNotification"
    ADD CONSTRAINT "UserNotification_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES public."Notification"(id) ON DELETE CASCADE;

CREATE INDEX CONCURRENTLY "UserNotification_userId_createdAt_idx" ON "UserNotification" ("userId", "createdAt" DESC) INCLUDE ("viewed", "notificationId");
CREATE INDEX CONCURRENTLY "Notification_id_with_category_idx" ON "Notification" (id) INCLUDE (category);

DROP INDEX "UserNotification_viewed_idx";
DROP INDEX "UserNotification_userId_idx";
DROP INDEX "UserNotification_createdAt_idx";
DROP INDEX "UserNotification_userId_viewed_createdAt_idx";
