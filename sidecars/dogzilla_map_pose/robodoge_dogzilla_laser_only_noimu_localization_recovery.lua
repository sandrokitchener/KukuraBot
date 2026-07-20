include "robodoge_dogzilla_laser_only_noimu_localization.lua"

TRAJECTORY_BUILDER.pure_localization_trimmer = {
  max_submaps_to_keep = 3,
}
options.rangefinder_sampling_ratio = 1.0
TRAJECTORY_BUILDER_2D.motion_filter.max_time_seconds = 1.0
POSE_GRAPH.optimize_every_n_nodes = 1
POSE_GRAPH.global_sampling_ratio = 1.0
POSE_GRAPH.global_constraint_search_after_n_seconds = 0.0
POSE_GRAPH.constraint_builder.global_localization_min_score = 0.45

return options
