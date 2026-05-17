import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { startTransition, useState, useRef, useCallback, useEffect } from 'react';
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

  // Previously created a new IntersectionObserver on every scroll event without
  // disconnecting the old one — a leak that accumulates across long conversations.
  // isNearBottom() reads scrollTop/scrollHeight which are already-available layout
  // values (no forced reflow) and serves the same purpose.
  const debouncedHandleScroll = useCallback(() => {
    debouncedSetShowScrollButton(!isNearBottom());
  }, [debouncedSetShowScrollButton, isNearBottom]);

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
        startTransition(() => setAbortScroll(false));
        scrollToBottom();
      } else if (!abortScroll) {
        // Content arrived in a large chunk and pushed the viewport more than
        // NEAR_BOTTOM_PX away from the bottom, but the user has never
        // intentionally scrolled up — keep following anyway.
        scrollToBottom();
      }
      // If abortScroll is true the user scrolled up on purpose; honour that.
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

  // Scroll to bottom whenever autoScroll preference fires.
  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    if (scrollToBottom && autoScroll && conversationId !== Constants.NEW_CONVO) {
      scrollToBottom();
    }
  }, [autoScroll, conversationId, scrollToBottom]);

  /**
   * Scroll to the bottom when navigating to an existing conversation.
   *
   * The effect above runs when conversationId changes, but if the messages
   * aren't yet cached they're still loading — messagesEndRef.current is null
   * and it bails out early. When messages finally arrive the deps haven't
   * changed so it never re-fires, leaving the viewport wherever it was.
   *
   * Fix: set a "just navigated" flag when conversationId changes. A second
   * effect watches messagesTree and, when the flag is set and messages first
   * appear, does one scroll-to-bottom then clears the flag. Subsequent
   * message updates (streaming tokens, etc.) leave the flag false so this
   * never interferes with user-initiated scrolling.
   */
  const justNavigatedRef = useRef(false);

  useEffect(() => {
    if (conversationId && conversationId !== Constants.NEW_CONVO) {
      justNavigatedRef.current = true;
    }
  }, [conversationId]);

  useEffect(() => {
    if (!justNavigatedRef.current) return;
    if (!messagesTree || messagesTree.length === 0) return;
    if (!scrollableRef.current) return;

    justNavigatedRef.current = false;
    const el = scrollableRef.current;

    // scrollIntoView targets the element's position at paint time, which can
    // be several hundred pixels short when lazy content (syntax-highlighted
    // code blocks, images) expands after the first frame.
    // Setting scrollTop = scrollHeight is always the true bottom — the browser
    // caps it automatically. We do it twice: once after the initial paint and
    // again after 250ms to catch anything that expanded in the interim.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setTimeout(() => { el.scrollTop = el.scrollHeight; }, 250);
    });
  }, [messagesTree]);

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
