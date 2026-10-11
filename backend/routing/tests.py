from datetime import datetime, timezone
from unittest import mock

from django.test import SimpleTestCase

from .services import risk
from .services.planner import checkpoint_miles, elapsed_with_hos
from .services.risk import HIGH, LOW, MODERATE, NO_TRAVEL, SEVERE


class ThresholdTests(SimpleTestCase):
    def test_wind_bands(self):
        cases = [(0, LOW), (24.9, LOW), (25, MODERATE), (34.9, MODERATE), (35, HIGH),
                 (44.9, HIGH), (45, SEVERE), (54.9, SEVERE), (55, NO_TRAVEL), (80, NO_TRAVEL)]
        for mph, expected in cases:
            self.assertEqual(risk.wind_level(mph), expected, mph)

    def test_rain_bands(self):
        cases = [(0, LOW), (0.099, LOW), (0.10, MODERATE), (0.249, MODERATE), (0.25, HIGH),
                 (0.49, HIGH), (0.50, SEVERE), (1.00, SEVERE), (1.01, NO_TRAVEL)]
        for rate, expected in cases:
            self.assertEqual(risk.rain_level(rate), expected, rate)

    def test_snow_bands(self):
        cases = [(0, LOW), (0.49, LOW), (0.5, MODERATE), (0.99, MODERATE), (1.0, HIGH),
                 (1.99, HIGH), (2.0, SEVERE), (3.0, SEVERE), (3.01, NO_TRAVEL)]
        for rate, expected in cases:
            self.assertEqual(risk.snow_level(rate), expected, rate)


class LoadRuleTests(SimpleTestCase):
    def test_55_mph_is_no_travel_for_any_load(self):
        self.assertEqual(risk.load_adjusted_wind_level(55, 0), NO_TRAVEL)

    def test_45_to_54_heavy_is_no_travel(self):
        self.assertEqual(risk.load_adjusted_wind_level(50, 30_001), NO_TRAVEL)
        self.assertEqual(risk.load_adjusted_wind_level(50, 30_000), SEVERE)

    def test_35_to_44_very_heavy_is_severe(self):
        self.assertEqual(risk.load_adjusted_wind_level(40, 40_001), SEVERE)
        self.assertEqual(risk.load_adjusted_wind_level(40, 40_000), HIGH)

    def test_light_wind_unaffected_by_load(self):
        self.assertEqual(risk.load_adjusted_wind_level(30, 80_000), MODERATE)

    def test_overall_is_worst_factor(self):
        a = risk.assess(wind_mph=10, rain_in_hr=0.3, snow_in_hr=0.6, load_lb=20_000)
        self.assertEqual(a.level, HIGH)
        self.assertEqual(a.driver, "rain")


class RankingTests(SimpleTestCase):
    def _s(self, segments):
        return risk.summarize(segments)

    def test_fewer_severe_miles_beats_faster(self):
        safe = risk.ranking_key(self._s([(LOW, 100), (HIGH, 50)]), duration_s=20_000)
        fast = risk.ranking_key(self._s([(LOW, 140), (SEVERE, 10)]), duration_s=10_000)
        self.assertLess(safe, fast)

    def test_fewer_high_miles_then_average_then_time(self):
        a = risk.ranking_key(self._s([(LOW, 100), (HIGH, 5)]), 9_000)
        b = risk.ranking_key(self._s([(LOW, 100), (HIGH, 10)]), 8_000)
        self.assertLess(a, b)
        c = risk.ranking_key(self._s([(LOW, 90), (MODERATE, 10)]), 9_000)
        d = risk.ranking_key(self._s([(LOW, 80), (MODERATE, 20)]), 8_000)
        self.assertLess(c, d)
        e = risk.ranking_key(self._s([(LOW, 100)]), 8_000)
        f = risk.ranking_key(self._s([(LOW, 100)]), 9_000)
        self.assertLess(e, f)

    def test_summary_weights_by_miles(self):
        s = self._s([(LOW, 75), (SEVERE, 25)])
        self.assertAlmostEqual(s["average_risk"], 0.75)
        self.assertEqual(s["miles_by_level"]["Severe"], 25)


class ScheduleTests(SimpleTestCase):
    def test_checkpoints_include_start_and_end(self):
        self.assertEqual(checkpoint_miles(60, 25), [0, 25, 50, 60])
        self.assertEqual(checkpoint_miles(52, 25), [0, 25, 52])  # no sliver checkpoint at 50

    def test_hours_of_service(self):
        h = 3600
        self.assertEqual(elapsed_with_hos(7 * h, True), 7 * h)
        self.assertEqual(elapsed_with_hos(9 * h, True), 9.5 * h)
        self.assertEqual(elapsed_with_hos(11 * h, True), 11.5 * h)
        self.assertEqual(elapsed_with_hos(12 * h, True), 12 * h + 10.5 * h)
        self.assertEqual(elapsed_with_hos(12 * h, False), 12 * h)


class PlanEndpointValidationTests(SimpleTestCase):
    def test_rejects_bad_interval(self):
        resp = self.client.post("/api/plan", data={
            "origin": {"lat": 40, "lon": -100}, "destination": {"lat": 41, "lon": -101},
            "departure": datetime.now(timezone.utc).isoformat(), "load_lb": 1000, "interval_mi": 15,
        }, content_type="application/json")
        self.assertEqual(resp.status_code, 400)

    def test_rejects_past_departure(self):
        resp = self.client.post("/api/plan", data={
            "origin": {"lat": 40, "lon": -100}, "destination": {"lat": 41, "lon": -101},
            "departure": "2020-01-01T00:00:00Z", "load_lb": 1000, "interval_mi": 25,
        }, content_type="application/json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("past", resp.json()["error"])

    @mock.patch("routing.views.history.save")
    @mock.patch("routing.views.plan_trip", return_value={"routes": []})
    def test_valid_request_calls_planner(self, plan, save):
        resp = self.client.post("/api/plan", data={
            "origin": {"lat": 40, "lon": -100, "label": "A"}, "destination": {"lat": 41, "lon": -101},
            "departure": datetime.now(timezone.utc).isoformat(), "load_lb": "38000", "interval_mi": 10,
        }, content_type="application/json")
        self.assertEqual(resp.status_code, 200)
        args = plan.call_args.args
        self.assertEqual(args[3], 38000)
        self.assertEqual(args[4], 10)
