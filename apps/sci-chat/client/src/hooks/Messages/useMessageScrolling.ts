import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { useState, useRef, useCallback, useEffect } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { useMessagesConversation, useMessagesSubmission } from '~/Providers';
import useScrollToRef from '~/hooks/useScrollToRef';
import store from '~/store';

const threshold = 0.85;
const debounceRate = 150;
/** Distance from bottom (px) at which we consider the user "at the bottom" */
const NEAR_BOTTOM_PX = 80;
/** How often (ms) we push the scroll position down during active streaming */
const STREAM_SCROLL_INTERVAL_MS = 100;

export default function useMessageScrolling(messagesTree?: TMessage[] | null) {
  const autoScroll = useRecoilValue(store.autoScroll);

  const scrollableRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const { conversation, conversationId } = useMessagesConversation();
  const { setAbortScroll, isSubmitting, abortScroll } = useMessagesSubmission();

  const timeoutIdRef = useRef<NodeJS.Timeout>();

  const debouncedSetShowScrollButton = useCallback((value: boolean) => {
    clearTimeout(timeoutIdRef.current);
    timeoutIdRef.current = setTimeout(() => {
      setShowScrollButton(value);
    }, debounceRate);
  }, []);

  /** Returns true when the scroll container is within NEAR_BOTTOM_PX of its bottom */
  const isNearBottom = useCallback(() => {
    const el = scrollableRef.current;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        debouncedSetShowScrollButton(!entry.isIntersecting);
      },
      { root: scrollableRef.current, threshold },
    );

    observer.observe(messagesEndRef.current);

    return () => {
      observer.disconnect();
      clearTimeout(timeoutIdRef.current);
    };
  }, [messagesEndRef, scrollableRef, debouncedSetShowScrollButton]);

  const debouncedHandleScroll = useCallback(() => {
    if (messagesEndRef.current && scrollableRef.current) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          debouncedSetShowScrollButton(!entry.isIntersecting);
        },
        { root: scrollableRef.current, threshold },
      );
      observer.observe(messagesEndRef.current);
      return () => observer.disconnect();
    }
  }, [debouncedSetShowScrollButton]);

  const scrollCallback = () => debouncedSetShowScrollButton(false);

  const { scrollToRef: scrollToBottom, handleSmoothToRef } = useScrollToRef({
    targetRef: messagesEndRef,
    callback: scrollCallback,
    smoothCallback: () => {
      scrollCallback();
      setAbortScroll(false);
    },
  });

  /**
   * Sticky-scroll during streaming.
   *
   * Runs an interval while `isSubmitting` is true. Each tick:
   * - If the user is near the bottom → re-engage auto-scroll (reset abortScroll)
   *   and push the view to the bottom.
   * - If the user has scrolled up significantly → honour abortScroll and do nothing.
   *
   * This replaces the old `messagesTree`-dep effect which only fired when the
   * tree reference changed (not when text content streamed into existing nodes).
   */
  useEffect(() => {
    if (!isSubmitting || !scrollToBottom) {
      return;
    }

    const tick = () => {
      if (isNearBottom()) {
        // User is at (or very near) the bottom — keep following the stream.
        setAbortScroll(false);
        scrollToBottom();
      }
      // If the user has scrolled up, abortScroll is already true (set by
      // useMessageHelpers/useMessageProcess handleScroll). We just don't
      // force-scroll them back down.
    };

    // Immediate first tick so there's no visible delay when a response starts.
    if (!abortScroll) {
      scrollToBottom();
    }

    const id = setInterval(tick, STREAM_SCROLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isSubmitting, scrollToBottom, setAbortScroll, isNearBottom, abortScroll]);

  /**
   * Re-engage auto-scroll when the user scrolls back to the bottom mid-stream.
   * The existing handleScroll in useMessageHelpers sets abortScroll=true when
   * scrolling up; here we flip it back to false when they return to the bottom.
   */
  useEffect(() => {
    if (!isSubmitting) return;
    const el = scrollableRef.current;
    if (!el) return;

    const onScroll = () => {
      if (isNearBottom()) {
        setAbortScroll(false);
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isSubmitting, isNearBottom, setAbortScroll]);

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    if (scrollToBottom && autoScroll && conversationId !== Constants.NEW_CONVO) {
      scrollToBottom();
    }
  }, [autoScroll, conversationId, scrollToBottom]);

  return {
    conversation,
    scrollableRef,
    messagesEndRef,
    scrollToBottom,
    showScrollButton,
    handleSmoothToRef,
    debouncedHandleScroll,
  };
}
