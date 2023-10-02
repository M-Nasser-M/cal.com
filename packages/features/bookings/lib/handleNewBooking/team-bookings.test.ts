import type { Request, Response } from "express";
import type { NextApiRequest, NextApiResponse } from "next";
import { describe, expect } from "vitest";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { SchedulingType } from "@calcom/prisma/enums";
import { BookingStatus } from "@calcom/prisma/enums";
import { test } from "@calcom/web/test/fixtures/fixtures";
import {
  createBookingScenario,
  getGoogleCalendarCredential,
  TestData,
  getOrganizer,
  getBooker,
  getScenarioData,
  mockSuccessfulVideoMeetingCreation,
  mockCalendarToHaveNoBusySlots,
  Timezones,
} from "@calcom/web/test/utils/bookingScenario/bookingScenario";
import {
  expectWorkflowToBeTriggered,
  expectSuccessfulBookingCreationEmails,
  expectBookingToBeInDatabase,
  expectBookingCreatedWebhookToHaveBeenFired,
  expectSuccessfulCalendarEventCreationInCalendar,
  expectSuccessfulVideoMeetingCreation,
} from "@calcom/web/test/utils/bookingScenario/expects";

import { createMockNextJsRequest } from "./createMockNextJsRequest";
import { getMockRequestDataForBooking } from "./getMockRequestDataForBooking";
import { setupAndTeardown } from "./setupAndTeardown";

export type CustomNextApiRequest = NextApiRequest & Request;

export type CustomNextApiResponse = NextApiResponse & Response;
// Local test runs sometime gets too slow
const timeout = process.env.CI ? 5000 : 20000;
describe("handleNewBooking", () => {
  setupAndTeardown();

  describe("Team Events", () => {
    describe("Collective Assignment", () => {
      test(
        `succesfully creates a booking
          - Destination calendars for event-type and non-first hosts are used to create calendar events
        `,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });

          const otherTeamMembers = [
            {
              name: "Other Team Member 1",
              username: "other-team-member-1",
              timeZone: Timezones["+5:30"],
              defaultScheduleId: 1,
              email: "other-team-member-1@example.com",
              id: 102,
              schedules: [TestData.schedules.IstWorkHours],
              credentials: [getGoogleCalendarCredential()],
              selectedCalendars: [TestData.selectedCalendars.google],
              destinationCalendar: {
                integration: "google_calendar",
                externalId: "other-team-member-1@google-calendar.com",
              },
            },
          ];

          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            credentials: [getGoogleCalendarCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
            destinationCalendar: {
              integration: "google_calendar",
              externalId: "organizer@google-calendar.com",
            },
          });

          await createBookingScenario(
            getScenarioData({
              webhooks: [
                {
                  userId: organizer.id,
                  eventTriggers: ["BOOKING_CREATED"],
                  subscriberUrl: "http://my-webhook.example.com",
                  active: true,
                  eventTypeId: 1,
                  appId: null,
                },
              ],
              eventTypes: [
                {
                  id: 1,
                  slotInterval: 45,
                  schedulingType: SchedulingType.COLLECTIVE,
                  length: 45,
                  users: [
                    {
                      id: 101,
                    },
                    {
                      id: 102,
                    },
                  ],
                  destinationCalendar: {
                    integration: "google_calendar",
                    externalId: "event-type-1@google-calendar.com",
                  },
                },
              ],
              organizer,
              usersApartFromOrganizer: otherTeamMembers,
              apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
            })
          );

          mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
            videoMeetingData: {
              id: "MOCK_ID",
              password: "MOCK_PASS",
              url: `http://mock-dailyvideo.example.com/meeting-1`,
            },
          });

          const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
            create: {
              id: "MOCKED_GOOGLE_CALENDAR_EVENT_ID",
              iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
            },
          });

          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: "integrations:daily" },
              },
            },
          });

          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });

          const createdBooking = await handleNewBooking(req);

          await expectBookingToBeInDatabase({
            description: "",
            location: "integrations:daily",
            responses: expect.objectContaining({
              email: booker.email,
              name: booker.name,
            }),
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            uid: createdBooking.uid!,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.ACCEPTED,
            references: [
              {
                type: "daily_video",
                uid: "MOCK_ID",
                meetingId: "MOCK_ID",
                meetingPassword: "MOCK_PASS",
                meetingUrl: "http://mock-dailyvideo.example.com/meeting-1",
              },
              {
                type: "google_calendar",
                uid: "MOCKED_GOOGLE_CALENDAR_EVENT_ID",
                meetingId: "MOCKED_GOOGLE_CALENDAR_EVENT_ID",
                meetingPassword: "MOCK_PASSWORD",
                meetingUrl: "https://UNUSED_URL",
              },
            ],
          });

          expectWorkflowToBeTriggered();
          expectSuccessfulCalendarEventCreationInCalendar(calendarMock, {
            destinationCalendars: [
              {
                integration: "google_calendar",
                externalId: "event-type-1@google-calendar.com",
              },
              {
                integration: "google_calendar",
                externalId: "other-team-member-1@google-calendar.com",
              },
            ],
            videoCallUrl: "http://mock-dailyvideo.example.com/meeting-1",
          });

          expectSuccessfulBookingCreationEmails({
            booker,
            organizer,
            otherTeamMembers,
            emails,
            iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
          });

          expectBookingCreatedWebhookToHaveBeenFired({
            booker,
            organizer,
            location: "integrations:daily",
            subscriberUrl: "http://my-webhook.example.com",
            videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
          });
        },
        timeout
      );
      test.only(
        `Video call uses credentials for the first host`,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });

          const otherTeamMembers = [
            {
              name: "Other Team Member 1",
              username: "other-team-member-1",
              timeZone: Timezones["+5:30"],
              defaultScheduleId: 1,
              email: "other-team-member-1@example.com",
              id: 102,
              schedules: [TestData.schedules.IstWorkHours],
              credentials: [getGoogleCalendarCredential()],
              selectedCalendars: [TestData.selectedCalendars.google],
              destinationCalendar: {
                integration: "google_calendar",
                externalId: "other-team-member-1@google-calendar.com",
              },
            },
          ];

          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            // Even though Daily Video credential isn't here, it would still work because it's a globally installed app and credentials are available on instance level
            credentials: [getGoogleCalendarCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
            destinationCalendar: {
              integration: "google_calendar",
              externalId: "organizer@google-calendar.com",
            },
          });

          await createBookingScenario(
            getScenarioData({
              webhooks: [
                {
                  userId: organizer.id,
                  eventTriggers: ["BOOKING_CREATED"],
                  subscriberUrl: "http://my-webhook.example.com",
                  active: true,
                  eventTypeId: 1,
                  appId: null,
                },
              ],
              eventTypes: [
                {
                  id: 1,
                  slotInterval: 45,
                  schedulingType: SchedulingType.COLLECTIVE,
                  length: 45,
                  users: [
                    {
                      id: 101,
                    },
                    {
                      id: 102,
                    },
                  ],
                  destinationCalendar: {
                    integration: "google_calendar",
                    externalId: "event-type-1@google-calendar.com",
                  },
                },
              ],
              organizer,
              usersApartFromOrganizer: otherTeamMembers,
              apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
            })
          );

          const videoMock = mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
            videoMeetingData: {
              id: "MOCK_ID",
              password: "MOCK_PASS",
              url: `http://mock-dailyvideo.example.com/meeting-1`,
            },
          });

          const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
            create: {
              id: "MOCKED_GOOGLE_CALENDAR_EVENT_ID",
              iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
            },
          });

          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: "integrations:daily" },
              },
            },
          });

          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });

          const createdBooking = await handleNewBooking(req);

          await expectBookingToBeInDatabase({
            description: "",
            location: "integrations:daily",
            responses: expect.objectContaining({
              email: booker.email,
              name: booker.name,
            }),
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            uid: createdBooking.uid!,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.ACCEPTED,
            references: [
              {
                type: "daily_video",
                uid: "MOCK_ID",
                meetingId: "MOCK_ID",
                meetingPassword: "MOCK_PASS",
                meetingUrl: "http://mock-dailyvideo.example.com/meeting-1",
              },
              {
                type: "google_calendar",
                uid: "MOCKED_GOOGLE_CALENDAR_EVENT_ID",
                meetingId: "MOCKED_GOOGLE_CALENDAR_EVENT_ID",
                meetingPassword: "MOCK_PASSWORD",
                meetingUrl: "https://UNUSED_URL",
              },
            ],
          });

          expectWorkflowToBeTriggered();
          expectSuccessfulCalendarEventCreationInCalendar(calendarMock, {
            destinationCalendars: [
              {
                integration: "google_calendar",
                externalId: "event-type-1@google-calendar.com",
              },
              {
                integration: "google_calendar",
                externalId: "other-team-member-1@google-calendar.com",
              },
            ],
            videoCallUrl: "http://mock-dailyvideo.example.com/meeting-1",
          });

          expectSuccessfulVideoMeetingCreation(videoMock, {
            credential: expect.objectContaining({}),
          });

          expectSuccessfulBookingCreationEmails({
            booker,
            organizer,
            otherTeamMembers,
            emails,
            iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
          });

          expectBookingCreatedWebhookToHaveBeenFired({
            booker,
            organizer,
            location: "integrations:daily",
            subscriberUrl: "http://my-webhook.example.com",
            videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
          });
        },
        timeout
      );
    });

    test.todo("Round Robin booking");
  });

  describe("Team Plus Paid Events", () => {
    test.todo("Collective event booking");
    test.todo("Round Robin booking");
  });
  test.todo("Calendar and video Apps installed on a Team  Account");
});
