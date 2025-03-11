import Router from 'next/router';
import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const auctionTour: StepWithData[] = [
  {
    target: '[data-tour="auction:start"]',
    placement: 'center',
    title: 'Getting Started with Auctions',
    content: 'Welcome to auctions! This tour will guide you through the process.',
    locale: { next: "Let's go" },
    disableBeacon: true,
    disableOverlayClose: true,
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
  },
  // TODO change verbiage if we allow more than models for auctions
  {
    target: '[data-tour="auction:start"]',
    placement: 'center',
    title: 'What are They?',
    content:
      'Each day, you can bid ⚡ Buzz to feature models on the homepage and resource selection areas of the site. These will appear the day after the auction concludes. Higher bids = better spots!',
    disableBeacon: true,
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
    data: {
      onNext: async () => {
        await Router.push({
          pathname: '/auctions',
        });
        await waitForElement({
          selector: '[data-tour="auction:nav"]',
          timeout: 30000,
        });
      },
    },
  },
  {
    target: '[data-tour="auction:nav"]',
    title: 'Select an Auction from the List',
    content: 'First, choose the auction you want to view or participate in.',
    disableBeacon: true,
    data: {
      onNext: async () => {
        await waitForElement({
          selector: '[data-tour="auction:info"]',
          timeout: 30000,
        });
      },
    },
  },
  {
    target: '[data-tour="auction:info"]',
    title: 'View Auction Info',
    content: 'Only a certain amount of models can win, and the minimum price must be met to place.',
    disableBeacon: true,
    data: {
      onNext: async () => {
        await waitForElement({
          selector: '[data-tour="auction:bid"]',
          timeout: 30000,
        });
      },
    },
  },
  {
    target: '[data-tour="auction:bid"]',
    title: 'Place Bid',
    content:
      'Choose a model, and place your bid! Optionally, you can have this recur every day until a set date.',
    disableBeacon: true,
    data: {
      onNext: async () => {
        await waitForElement({
          selector: '[data-tour="auction:bid-results"]',
          timeout: 30000,
        });
      },
    },
  },
  {
    target: '[data-tour="auction:bid-results"]',
    title: 'View Bids',
    content:
      "Below, you'll see a list of the top bids (including those beneath the minimum price, if any).",
    disableBeacon: true,
  },
  {
    target: '[data-tour="auction:start"]',
    placement: 'center',
    title: 'Then What?',
    content:
      "At the end of the day, winners will be determined. If you're one of them, your model will appear featured around the site! If not, you'll be fully refunded.",
    disableBeacon: true,
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
    data: {
      onNext: async () => {
        await waitForElement({
          selector: '[data-tour="auction:reset"]',
          timeout: 30000,
        });
      },
    },
  },
  {
    target: '[data-tour="auction:reset"]',
    title: 'All Done',
    content: "That's it! If you want to see this tour again, click this button.",
    disableBeacon: true,
  },
];
