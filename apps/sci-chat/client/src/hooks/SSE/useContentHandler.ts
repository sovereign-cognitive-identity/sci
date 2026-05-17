import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';

import type {
  Text,
  TMessage,
  ImageFile,
  ContentPart,
  PartMetadata,
  TContentData,
  EventSubmission,
  TMessageContentParts,
} from 'librechat-data-provider';
import { addFileToCache } from '~/utils';

type TUseContentHandler = {
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
};

type TContentHandler = {
  data: TContentData;
  submission: EventSubmission;
};

export default function useContentHandler({ setMessages, getMessages }: TUseContentHandler) {
  const queryClient = useQueryClient();
  const messageMap = useMemo(() => new Map<string, TMessage>(), []);

  // Use a ref so the RAF callback always has the latest setMessages without stale closures
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  // Pending messages buffered between animation frames
  const pendingMessagesRef = useRef<TMessage[] | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Flush pending messages to React Query — called at most once per animation frame
  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const pending = pendingMessagesRef.current;
      if (pending !== null) {
        pendingMessagesRef.current = null;
        setMessagesRef.current(pending);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  /** Reset the message map - call this after sync to prevent stale state from overwriting synced content */
  const resetMessageMap = useCallback(() => {
    messageMap.clear();
    // Flush any pending render immediately so the final state is committed before reset
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const pending = pendingMessagesRef.current;
    if (pending !== null) {
      pendingMessagesRef.current = null;
      setMessagesRef.current(pending);
    }
  }, [messageMap]);

  const handler = useCallback(
    ({ data, submission }: TContentHandler) => {
      const { type, messageId, thread_id, conversationId, index } = data;

      const _messages = getMessages();
      // Preserve object refs for messages whose thread_id already matches — avoids creating
      // new objects for every non-streaming message on every SSE token
      const messages =
        _messages
          ?.filter((m) => m.messageId !== messageId)
          .map((msg) => (msg.thread_id === thread_id ? msg : { ...msg, thread_id })) ?? [];
      const userMessage = messages[messages.length - 1] as TMessage | undefined;

      const { initialResponse } = submission;

      let response = messageMap.get(messageId);
      if (!response) {
        // Check if message already exists in current messages (e.g., after sync)
        // Use that as base instead of stale initialResponse
        const existingMessage = _messages?.find((m) => m.messageId === messageId);
        response = {
          ...(existingMessage ?? (initialResponse as TMessage)),
          parentMessageId: userMessage?.messageId ?? '',
          conversationId,
          messageId,
          thread_id,
        };
        messageMap.set(messageId, response);
      }

      // TODO: handle streaming for non-text
      const textPart: Text | string | undefined = data[ContentTypes.TEXT];
      const part: ContentPart =
        textPart != null && typeof textPart === 'string' ? { value: textPart } : data[type];

      if (type === ContentTypes.IMAGE_FILE) {
        addFileToCache(queryClient, part as ImageFile & PartMetadata);
      }

      /* spreading the content array to avoid mutation */
      response.content = [...(response.content ?? [])];

      response.content[index] = { type, [type]: part } as TMessageContentParts;

      const lastContentPart = response.content[response.content.length - 1];
      const initialContentPart = initialResponse.content?.[0];
      if (
        type !== ContentTypes.TEXT &&
        initialContentPart != null &&
        lastContentPart != null &&
        ((lastContentPart.type === ContentTypes.TOOL_CALL &&
          lastContentPart[ContentTypes.TOOL_CALL]?.progress === 1) ||
          lastContentPart.type === ContentTypes.IMAGE_FILE)
      ) {
        response.content.push(initialContentPart);
      }

      // Buffer the update and schedule a render on the next animation frame (~60 FPS cap).
      // This prevents O(N) re-renders per token when LLMs stream faster than the display rate.
      pendingMessagesRef.current = [...messages, response];
      scheduleFlush();
    },
    [queryClient, getMessages, messageMap, scheduleFlush],
  );

  return { contentHandler: handler, resetContentHandler: resetMessageMap };
}
